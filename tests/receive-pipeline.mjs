import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, ".test-output", "receive-pipeline");
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
const notificationBodies = [];
const notifications = {
    showNotification(...args) {
        notificationBodies.push(args[2]);
    },
    playNotificationSound() {},
};
globalThis.receivePipelineStore = {
    getMessage: (_channel, id) => raw.get(id),
    getMessages: () => raw,
    emitChange() {},
};
const events = [];
globalThis.receivePipelineDispatcher = {
    dispatch(event) {
        events.push(event);
        if (event.type === "LOAD_MESSAGES_SUCCESS")
            raw = new NativeChannel(
                event.messages.map((m) => new NativeMessage({ ...m, channel_id: channel })),
            );
        if (event.type === "MESSAGE_CREATE")
            raw = new NativeChannel([
                ...raw._array.filter((m) => m.id !== event.message.id),
                new NativeMessage(event.message),
            ]);
        if (event.type === "MESSAGE_UPDATE")
            raw = new NativeChannel(
                raw._array.map((m) => (m.id === event.message.id ? m.merge(event.message) : m)),
            );
        if (event.type === "MESSAGE_DELETE")
            raw = new NativeChannel(raw._array.filter((m) => m.id !== event.id));
    },
};
let imageRequests = 0,
    previewRequests = 0,
    fileRequests = 0;
globalThis.Image = class {
    set src(_value) {
        imageRequests++;
    }
    naturalWidth = 128;
    naturalHeight = 128;
    decode() {
        return Promise.resolve();
    }
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 1);
globalThis.receivePipelineNotifications = notifications;
const stub = path.join(work, "stub.mjs");
await writeFile(
    stub,
    `export const MessageStore=globalThis.receivePipelineStore; export const UserStore={getCurrentUser:()=>({id:${JSON.stringify(self)}})}; export const FluxDispatcher=globalThis.receivePipelineDispatcher; export const showToast=()=>{}; export const findByCodeLazy=()=>async url=>url; export const findByPropsLazy=(...props)=>props.includes('showNotification')?globalThis.receivePipelineNotifications:{};`,
);
const entry = path.join(work, "entry.ts");
await writeFile(
    entry,
    `export * from '../../src/ReadingPolicy'; export * from '../../src/ReceiveMessages'; export * from '../../src/MessageView'; export * from '../../src/WireMessages'; export * from '../../src/FileAttachments'; export * from '../../src/PreviewEmbeds'; export * from '../../src/MessagePresentation'; export * from '../../src/MessageColors';`,
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
let keyFixed = false;
const native = {
    async channelInfo() {
        return { reading: true, previews: "manual" };
    },
    async decryptMessage(_channel, _author, text) {
        decryptCalls++;
        if (text === "[VCS1:bad]") throw new Error("Bad key");
        return text === "[VCS1:history]" ? "First line\nSecond line\nThird line" : "plain";
    },
    async decryptMessages(_channel, messages) {
        batchCalls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return messages.map((message) =>
            message.content === "[VCS1:bad]" && !keyFixed
                ? { error: true }
                : { text: "First line\nSecond line\nThird line" },
        );
    },
    async decryptAttachment() {
        fileRequests++;
        return {
            encrypted: true,
            filename: "photo.gif",
            mime: "image/gif",
            data: new Uint8Array([71, 73, 70, 56, 57, 97]),
        };
    },
    async resolveGifPreview() {
        previewRequests++;
        return { url: "https://media.tenor.com/test.gif", video: false };
    },
};
const getMessage = receivePipelineStore.getMessage,
    getMessages = receivePipelineStore.getMessages;
const restore = model.installMessagePresentation(native);
assert.equal(receivePipelineStore.getMessage, getMessage);
assert.equal(receivePipelineStore.getMessages, getMessages);
const event = {
    type: "LOAD_MESSAGES_SUCCESS",
    channelId: channel,
    messages: [
        {
            id: "456789012345678901",
            author: { id: author },
            content: "[VCS1:history]",
            edited_timestamp: "2026-10-11T22:00:00Z",
        },
        { id: "456789012345678902", author: { id: author }, content: "[VCS1:bad]" },
    ],
};
const delivering = receivePipelineDispatcher.dispatch(event);
assert.equal(events.length, 0);
await delivering;
assert.equal(batchCalls, 1);
assert.equal(events[0].messages[0].content, "First line\nSecond line\nThird line");
assert.equal(raw._array[0].content, "First line\nSecond line\nThird line");
assert.equal(raw._array[1].content, "Unable to decrypt. Check this chat's key.");
assert.equal(event.messages[0].content, "[VCS1:history]");
assert.equal(events[0].messages[0].edited_timestamp, event.messages[0].edited_timestamp);
assert.equal(model.wireMessage(raw._array[0]).content, "[VCS1:history]");
assert.equal(receivePipelineStore.getMessages(channel), raw);
assert.equal(receivePipelineStore.getMessage, getMessage);
assert.equal(receivePipelineStore.getMessages, getMessages);
assert.ok(model.encryptedEdit(channel, event.messages[0].id));
console.log(
    "PASS plaintext reaches the original dispatcher and backing store; readers are untouched; ciphertext and edit protection are retained separately",
);
const before = events.length;
const pendingPage = receivePipelineDispatcher.dispatch({
    type: "LOAD_MESSAGES_SUCCESS",
    channelId: channel,
    messages: [{ id: "456789012345678907", author: { id: author }, content: "[VCS1:pending]" }],
});
const deletion = { type: "MESSAGE_DELETE", channelId: channel, id: "456789012345678907" };
const deleting = receivePipelineDispatcher.dispatch(deletion);
assert.equal(events.length, before);
await Promise.all([pendingPage, deleting]);
assert.equal(events[before].type, "LOAD_MESSAGES_SUCCESS");
assert.equal(events[before + 1], deletion);
const reply = {
    id: "456789012345678908",
    channel_id: channel,
    author: { id: author },
    content: "[VCS1:reply]",
    referenced_message: { id: "456789012345678909", author: { id: self }, content: "original" },
};
model.rememberPlaintext(channel, author, reply.content, "hello");
assert.ok(model.receivedPayload(reply, channel).mentions.some((user) => user.id === self));
const file = {
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
};
model.receivedPayload(file, channel);
assert.equal(model.wasEncrypted(channel, file.id), false, "a .vcs suffix alone is not proof of encryption");
await model.prepareAttachmentViews(native, file);
const fileDto = model.receivedPayload(file, channel);
assert.equal(
    model.wasEncrypted(channel, file.id),
    true,
    "authenticated decrypted file retains edit protection",
);
assert.equal(fileDto.attachments.length, 1);
assert.equal(fileDto.attachments[0].filename, "photo.gif");
assert.equal(fileDto.attachments[0].content_type, "image/gif");
assert.ok(fileDto.attachments[0].url.startsWith("blob:"));
assert.equal(file.attachments[0].filename, "encrypted.vcs");
const emojiText =
    "look [tiktokangry](https://cdn.discordapp.com/emojis/1440406417541431500.webp?size=512&name=tiktokangry&lossless=true)";
const emoji = {
    id: "456789012345678906",
    channel_id: channel,
    author: { id: author },
    content: "[VCS1:emoji]",
    embeds: [],
};
model.rememberPlaintext(channel, author, emoji.content, emojiText);
model.allowMessagePreview(emoji);
await model.preparePreviewEmbeds(native, emojiText, emoji);
const dto = model.receivedPayload(emoji, channel);
assert.equal(dto.embeds.length, 1);
assert.equal(dto.embeds[0].type, "image");
assert.equal(dto.embeds[0].thumbnail.content_type, "image/webp");
for (const forbidden of ["rawTitle", "rawDescription", "title", "description", "color", "id"])
    assert.equal(Object.hasOwn(dto.embeds[0], forbidden), false);
assert.equal(Object.hasOwn(dto.embeds[0].thumbnail, "proxyURL"), false);
assert.equal(emoji.embeds.length, 0);
console.log(
    "PASS ordered history/deletion, raw mention DTOs, decrypted attachments and raw media metadata without fabricated normalized fields",
);
for (const type of [
    "LOAD_MESSAGES_AROUND_SUCCESS",
    "LOAD_RECENT_MENTIONS_SUCCESS",
    "SEARCH_MESSAGES_SUCCESS",
    "MOD_VIEW_SEARCH_MESSAGES_SUCCESS",
    "LOAD_PINNED_MESSAGES_SUCCESS",
    "CONVERSATION_MESSAGES_FETCH_SUCCESS",
]) {
    const msg = {
        id: "650000000000000001",
        channel_id: channel,
        author: { id: author },
        content: `[VCS1:${type}]`,
    };
    const envelope =
        type === "LOAD_PINNED_MESSAGES_SUCCESS"
            ? { pins: [{ message: msg, pinned_at: "2026-10-12" }] }
            : { messages: [[msg]], messageReferences: [msg] };
    const original = { type, ...envelope };
    await receivePipelineDispatcher.dispatch(original);
    const delivered = events.findLast((event) => event.type === type);
    const mapped = delivered.pins?.[0].message ?? delivered.messages[0][0];
    assert.equal(mapped.content, "First line\nSecond line\nThird line");
    assert.equal(msg.content, `[VCS1:${type}]`);
    assert.equal(model.getWireMessage(channel, msg.id).content, msg.content);
}
const editable = {
    id: "650000000000000002",
    channel_id: channel,
    author: { id: author },
    timestamp: "2026-10-12T00:00:00Z",
    content: "[VCS1:editable]",
};
await receivePipelineDispatcher.dispatch({ type: "MESSAGE_CREATE", message: editable });
const edit = {
    type: "MESSAGE_UPDATE",
    message: {
        id: editable.id,
        channel_id: channel,
        content: "[VCS1:newedit]",
        edited_timestamp: "2026-10-12T00:01:00Z",
    },
};
await receivePipelineDispatcher.dispatch(edit);
const editedEvent = events.findLast(
    (event) => event.type === "MESSAGE_UPDATE" && event.message.id === editable.id,
);
assert.equal(editedEvent.message.author.id, author);
assert.equal(editedEvent.message.timestamp, editable.timestamp);
assert.equal(editedEvent.message.edited_timestamp, edit.message.edited_timestamp);
assert.equal(editedEvent.message.content, "First line\nSecond line\nThird line");
assert.equal(edit.message.content, "[VCS1:newedit]");
assert.equal(model.getWireMessage(channel, editable.id).content, "[VCS1:newedit]");
assert.ok(model.encryptedEdit(channel, editable.id));
const retry = {
    id: "650000000000000003",
    channel_id: channel,
    author: { id: author },
    content: "[VCS1:bad]",
};
await receivePipelineDispatcher.dispatch({ type: "MESSAGE_CREATE", message: retry });
assert.match(receivePipelineStore.getMessage(channel, retry.id).content, /Unable to decrypt/);
keyFixed = true;
model.retryFailedMessages();
model.refreshReceivedMessages(true);
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(
    receivePipelineStore.getMessage(channel, retry.id).content,
    "First line\nSecond line\nThird line",
);
assert.equal(model.getWireMessage(channel, retry.id).content, "[VCS1:bad]");
// Evict the small text cache. A later file/preview refresh must not blank records
// that Discord already received successfully.
for (let i = 0; i < 550; i++) model.rememberPlaintext(channel, author, `[VCS1:evict${i}]`, "unrelated");
model.refreshReceivedMessages();
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(
    receivePipelineStore.getMessage(channel, editable.id).content,
    "First line\nSecond line\nThird line",
);
const cached = new NativeMessage({
    id: "650000000000000004",
    channel_id: channel,
    author: { id: author },
    content: "[VCS1:cached]",
});
raw = new NativeChannel([...raw._array, cached]);
model.receiveCachedMessage(cached);
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(
    receivePipelineStore.getMessage(channel, cached.id).content,
    "First line\nSecond line\nThird line",
);
console.log(
    "PASS real history/pin/search actions, nested raw payloads, partial edits, key retry, cached records on enable, and plaintext surviving cache eviction",
);

model.rememberReadingPolicy(channel, { reading: false, previews: "manual" });
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(receivePipelineStore.getMessage(channel, editable.id).content, "[VCS1:newedit]");
assert.equal(model.receivedPayload(file, channel).attachments[0].filename, "encrypted.vcs");
const hidden = {
    id: "650000000000000010",
    channel_id: channel,
    author: { id: author },
    content: "[VCS1:hidden]",
};
const decryptionCount = decryptCalls + batchCalls;
await receivePipelineDispatcher.dispatch({ type: "MESSAGE_CREATE", message: hidden });
assert.equal(receivePipelineStore.getMessage(channel, hidden.id).content, hidden.content);
assert.equal(decryptCalls + batchCalls, decryptionCount);
const fileCount = fileRequests;
await model.prepareAttachmentViews(native, {
    ...file,
    attachments: [{ ...file.attachments[0], id: "567890123456789999" }],
});
assert.equal(fileRequests, fileCount);
notifications.showNotification("title", "icon", hidden.content, {
    channel_id: channel,
    message_id: hidden.id,
});
assert.equal(notificationBodies.at(-1), hidden.content);
assert.ok(model.encryptedEdit(channel, hidden.id));
model.rememberReadingPolicy(channel, { reading: true, previews: "manual" });
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(
    receivePipelineStore.getMessage(channel, hidden.id).content,
    "First line\nSecond line\nThird line",
);
const linkText = "https://tenor.com/view/private-click-test";
const clicked = { ...hidden, id: "650000000000000011", content: "[VCS1:click]", embeds: [] };
model.rememberPlaintext(channel, author, clicked.content, linkText);
let beforeRequests = imageRequests + previewRequests;
await model.preparePreviewEmbeds(native, linkText, clicked);
assert.equal(imageRequests + previewRequests, beforeRequests);
assert.equal(model.receivedPayload(clicked, channel).embeds.length, 0);
model.allowMessagePreview(clicked);
await model.preparePreviewEmbeds(native, linkText, clicked);
assert.ok(imageRequests + previewRequests > beforeRequests);
assert.equal(model.receivedPayload(clicked, channel).embeds.length, 1);
const unclicked = { ...clicked, id: "650000000000000012" };
assert.equal(
    model.receivedPayload(unclicked, channel).embeds.length,
    0,
    "cached URLs do not grant another message permission",
);
assert.equal(
    model.receivedPayload(
        { ...unclicked, embeds: [{ type: "image", url: "https://example.com/preexisting-preview" }] },
        channel,
    ).embeds.length,
    0,
    "preexisting raw embeds cannot bypass manual mode",
);
const changedLink = { ...clicked, content: "[VCS1:edited-link]" };
model.rememberPlaintext(channel, author, changedLink.content, linkText);
assert.equal(model.previewsAllowed(changedLink), false, "edits invalidate per-message grants");
model.rememberReadingPolicy(channel, { reading: true, previews: "never" });
beforeRequests = imageRequests + previewRequests;
model.allowMessagePreview(clicked);
await model.preparePreviewEmbeds(native, linkText, clicked);
assert.equal(imageRequests + previewRequests, beforeRequests);
assert.equal(model.receivedPayload(clicked, channel).embeds.length, 0);
model.rememberIncoming({ ...unclicked, embeds: [] }, channel);
model.rememberReadingPolicy(channel, { reading: true, previews: "automatic" });
assert.equal(model.receivedPayload(unclicked, channel).embeds.length, 1);
// If policy changes while resolving a GIF page, its response must not start the
// subsequent image request or become a displayed embed.
let completeResolution;
const delayedNative = {
    ...native,
    resolveGifPreview: () =>
        new Promise((resolve) => {
            completeResolution = resolve;
        }),
};
const delayed = { ...clicked, id: "650000000000000013", content: "[VCS1:delayed-preview]" };
const delayedText = "https://tenor.com/view/delayed-private-test";
model.rememberPlaintext(channel, author, delayed.content, delayedText);
const delayedLoad = model.preparePreviewEmbeds(delayedNative, delayedText, delayed);
const beforeImages = imageRequests;
model.rememberReadingPolicy(channel, { reading: false, previews: "manual" });
completeResolution({ url: "https://media.tenor.com/late.gif", video: false });
await delayedLoad;
assert.equal(imageRequests, beforeImages);
assert.equal(model.receivedPayload(delayed, channel).content, delayed.content);
assert.equal(model.cachedPreviewEmbeds(delayedText).length, 0);
model.rememberReadingPolicy(channel, { reading: true, previews: "manual" });
assert.equal(model.previewsAllowed(clicked), false, "switching reading off clears previous grants");
console.log(
    "PASS raw reading view, no decryption/download while off, raw notifications, preserved edit protection, per-message consent, cached URL isolation, never/automatic modes, edited links and in-flight policy changes",
);

restore();
assert.equal(receivePipelineStore.getMessage(channel, editable.id).content, "[VCS1:newedit]");
assert.equal(
    receivePipelineStore.getMessage(channel, editable.id).edited_timestamp,
    edit.message.edited_timestamp,
);
assert.equal(receivePipelineStore.getMessage, getMessage);
assert.equal(receivePipelineStore.getMessages, getMessages);
model.clearMessageCache();
