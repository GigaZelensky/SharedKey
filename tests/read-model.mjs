import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, ".test-output", "read-model");
await mkdir(work, { recursive: true });
const channel = "123456789012345678",
    author = "234567890123456789",
    self = "345678901234567890";
class NativeMessage {
    constructor(data) {
        Object.assign(this, { attachments: [], embeds: [], mentions: [], mentioned: false, ...data });
    }
    merge(changes) {
        return new NativeMessage({ ...this, ...changes });
    }
    isEdited() {
        return !!this.editedTimestamp;
    }
    getContentMessage() {
        return this;
    }
}
class NativeCache {
    constructor(messages) {
        this._messages = messages;
        this._map = Object.fromEntries(messages.map((m) => [m.id, m]));
    }
    get(id) {
        return this._map[id];
    }
}
class NativeChannel {
    constructor(messages) {
        this._array = messages;
        this._map = Object.fromEntries(messages.map((m) => [m.id, m]));
        this._before = new NativeCache(messages);
        this._after = new NativeCache([]);
        this.loadingMore = false;
    }
    get(id) {
        return this._map[id];
    }
}
let raw = new NativeChannel([]);
const notifications = { showNotification() {}, playNotificationSound() {} };
globalThis.readModelStore = {
    getMessage: (_channel, id) => raw.get(id),
    getMessages: () => raw,
    emitChange() {},
};
const events = [];
globalThis.readModelDispatcher = {
    dispatch(event) {
        events.push(event);
        if (event.type === "MESSAGE_LOAD_SUCCESS")
            raw = new NativeChannel(
                event.messages.map((m) => new NativeMessage({ ...m, channel_id: channel })),
            );
    },
};
globalThis.Image = class {
    naturalWidth = 128;
    naturalHeight = 128;
    decode() {
        return Promise.resolve();
    }
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 1);
globalThis.readModelNotifications = notifications;
const stub = path.join(work, "stub.mjs");
await writeFile(
    stub,
    `export const MessageStore=globalThis.readModelStore; export const UserStore={getCurrentUser:()=>({id:${JSON.stringify(self)}})}; export const FluxDispatcher=globalThis.readModelDispatcher; export const showToast=()=>{}; export const findByCodeLazy=()=>async url=>url; export const findByPropsLazy=(...props)=>props.includes('showNotification')?globalThis.readModelNotifications:{};`,
);
const entry = path.join(work, "entry.ts");
await writeFile(
    entry,
    `export * from '../../src/MessageProjection'; export * from '../../src/MessageView'; export * from '../../src/WireMessages'; export * from '../../src/FileAttachments'; export * from '../../src/PreviewEmbeds'; export * from '../../src/MessagePresentation'; export * from '../../src/MessageColors';`,
);
const outfile = path.join(work, "model.mjs");
await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    plugins: [
        {
            name: "vencord-boundary",
            setup(b) {
                b.onResolve({ filter: /^@/ }, () => ({ path: stub }));
            },
        },
    ],
});
const model = await import(pathToFileURL(outfile));
let decryptCalls = 0;
let batchCalls = 0;
const native = {
    async decryptMessage(_channel, _author, text) {
        decryptCalls++;
        if (text === "[VCS1:bad]") throw new Error("Bad key");
        return text === "[VCS1:history]" ? "First line\nSecond line\nThird line" : "plain";
    },
    async decryptMessages(_channel, messages) {
        batchCalls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return messages.map((message) =>
            message.content === "[VCS1:bad]"
                ? { error: true }
                : { text: "First line\nSecond line\nThird line" },
        );
    },
    async decryptAttachment() {
        return {
            encrypted: true,
            filename: "photo.gif",
            mime: "image/gif",
            data: new Uint8Array([71, 73, 70, 56, 57, 97]),
        };
    },
    async resolveGifPreview() {
        return { url: "https://media.tenor.com/test.gif", video: false };
    },
};
const restoreModel = model.installMessageProjection();
const restorePresentation = model.installMessagePresentation(native);
const event = {
    type: "MESSAGE_LOAD_SUCCESS",
    channelId: channel,
    messages: [
        {
            id: "456789012345678901",
            author: { id: author },
            content: "[VCS1:history]",
            editedTimestamp: new Date("2026-10-11T22:00:00Z"),
        },
        { id: "456789012345678902", author: { id: author }, content: "[VCS1:bad]" },
    ],
};
const delivering = readModelDispatcher.dispatch(event);
assert.equal(events.length, 0, "Ciphertext history must not reach the virtual list before preparation");
await delivering;
const view = readModelStore.getMessages(channel);
assert.equal(batchCalls, 1);
assert.equal(view._array[0].content, "First line\nSecond line\nThird line");
assert.equal(view._array[1].content, "Unable to decrypt. Check this chat's key.");
assert.equal(raw._array[0].content, "[VCS1:history]");
assert.equal(event.messages[0].content, "[VCS1:history]");
assert.ok(view instanceof NativeChannel);
assert.ok(view.get(view._array[0].id) instanceof NativeMessage);
assert.ok(view.get(view._array[0].id).isEdited());
assert.equal(view.get(view._array[0].id).editedTimestamp, event.messages[0].editedTimestamp);
assert.equal(view._before.get(view._array[0].id).content, "First line\nSecond line\nThird line");
assert.equal(raw._before.get(view._array[0].id).content, "[VCS1:history]");
assert.equal(readModelStore.getMessages(channel), view, "Selectors need a stable projected container");
assert.equal(model.wireMessage(view.get(view._array[0].id)), raw._array[0]);
console.log(
    "PASS history decrypts before dispatch; native message/channel/cache prototypes, edited metadata and original ciphertext are preserved",
);
const before = events.length;
const pendingPage = readModelDispatcher.dispatch({
    type: "MESSAGE_LOAD_SUCCESS",
    channelId: channel,
    messages: [{ id: "456789012345678907", author: { id: author }, content: "[VCS1:pending]" }],
});
const deletion = { type: "MESSAGE_DELETE", channelId: channel, id: "456789012345678907" };
const deleting = readModelDispatcher.dispatch(deletion);
assert.equal(events.length, before);
await Promise.all([pendingPage, deleting]);
assert.equal(events[before].type, "MESSAGE_LOAD_SUCCESS");
assert.equal(events[before + 1], deletion);
console.log("PASS a deletion cannot overtake pending history decryption in the same channel");
const own = new NativeMessage({
    id: "456789012345678903",
    channel_id: channel,
    author: { id: self },
    content: "original",
});
const reply = new NativeMessage({
    id: "456789012345678904",
    channel_id: channel,
    author: { id: author },
    content: "[VCS1:reply]",
    messageReference: { message_id: own.id, channel_id: channel },
});
raw = new NativeChannel([own, reply]);
model.rememberPlaintext(channel, author, reply.content, "hello");
const replyView = readModelStore.getMessage(channel, reply.id);
assert.equal(replyView.mentioned, true);
assert.equal(reply.mentioned, false);
assert.equal(replyView.content, "hello");
assert.equal(readModelStore.getMessage(channel, own.id), own);
assert.ok(
    model.encryptedEdit(channel, reply.id),
    "Encrypted edits still use the original record with encryption off",
);
const highlight = model.highlightedTint("#7d52ff", 0.14);
assert.notEqual(highlight, model.messageTint("#7d52ff", 0.14));
console.log(
    "PASS replies to the current user receive native mention highlighting; ordinary records stay untouched and encryption guards recognize projected edits",
);
const file = new NativeMessage({
    id: "456789012345678905",
    channel_id: channel,
    author: { id: author },
    content: "",
    attachments: [
        {
            id: "567890123456789012",
            filename: "encrypted.vcs",
            size: 6,
            url: "https://cdn.discordapp.com/attachments/example/encrypted.vcs",
        },
    ],
});
await model.prepareAttachmentViews(native, file);
const fileView = model.projectMessage(file);
assert.equal(fileView.attachments.length, 1);
assert.equal(fileView.attachments[0].filename, "photo.gif");
assert.equal(fileView.attachments[0].content_type, "image/gif");
assert.equal(fileView.attachments[0].width, 128);
assert.ok(fileView.attachments[0].url.startsWith("blob:"));
assert.ok(fileView.attachments[0].url.endsWith(".gif"));
assert.equal(model.localImage(fileView.attachments[0].url).mime, "image/gif");
assert.equal(file.attachments[0].filename, "encrypted.vcs");
const emojiText =
    "look [tiktokangry](https://cdn.discordapp.com/emojis/1440406417541431500.webp?size=512&name=tiktokangry&lossless=true)";
const emoji = new NativeMessage({
    id: "456789012345678906",
    channel_id: channel,
    author: { id: author },
    content: "[VCS1:emoji]",
});
model.rememberPlaintext(channel, author, emoji.content, emojiText);
await model.preparePreviewEmbeds(native, emojiText);
const emojiView = model.projectMessage(emoji);
assert.equal(emojiView.embeds.length, 1);
assert.equal(emojiView.embeds[0].type, "image");
assert.equal(emojiView.embeds[0].image.contentType, "image/webp");
assert.equal(emoji.embeds.length, 0);
assert.equal(decryptCalls, 0, "Prepared records do not start another decryption pass");
console.log(
    "PASS native attachment models expose exactly one decrypted GIF with dimensions; emoji URLs become native embeds without changing wire data",
);
restorePresentation();
restoreModel();
assert.equal(readModelStore.getMessages(channel), raw);
assert.equal(readModelStore.getMessage(channel, reply.id).content, "[VCS1:reply]");
model.clearMessageCache();
console.log("PASS disabling restores the original store APIs and clears local preview data");
