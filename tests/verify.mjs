import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));
const { build } = require("esbuild");
const source = path.join(root, "src");
const work = path.join(root, ".test-output");
await mkdir(work, { recursive: true });
await build({
    entryPoints: [path.join(source, "crypto.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(work, "crypto.mjs"),
});
const crypto = await import(pathToFileURL(path.join(work, "crypto.mjs")));
const key = crypto.generateKey();
const otherKey = crypto.generateKey();
const keys = { [crypto.keyId(key)]: key };
const channel = "123456789012345678";
const author = "234567890123456789";
let checks = 0;
const check = (label, fn) => {
    fn();
    checks++;
    console.log(`PASS ${label}`);
};
const roundtrip = (text) => {
    const encrypted = crypto.encryptText(text, key, channel, author);
    assert.equal(crypto.decryptText(encrypted, keys, channel, author), text);
    return encrypted;
};
check("256-bit generated keys and canonical encoding", () => {
    assert.equal(crypto.parseKey(key).length, 32);
    assert.notEqual(key, otherKey);
    assert.throws(() => crypto.parseKey("password"));
});
check("Unicode, multiline, emoji, markup and empty text", () =>
    ["", "hello", "🔒 Привет\nこんにちは\n<@12345> **bold**", "x".repeat(4000)].forEach(roundtrip),
);
const ciphertext = roundtrip("secret text");
check("Fresh nonces", () =>
    assert.notEqual(ciphertext, crypto.encryptText("secret text", key, channel, author)),
);
check("Wrong key is rejected", () =>
    assert.throws(() =>
        crypto.decryptText(ciphertext, { [crypto.keyId(otherKey)]: otherKey }, channel, author),
    ),
);
check("Modified ciphertext and tag are rejected", () => {
    const data = Buffer.from(ciphertext.slice(6, -1), "base64url");
    data[22] ^= 1;
    assert.throws(() => crypto.decryptText(`[VCS1:${data.toString("base64url")}]`, keys, channel, author));
    data[data.length - 1] ^= 1;
    assert.throws(() => crypto.decryptText(`[VCS1:${data.toString("base64url")}]`, keys, channel, author));
});
check("Copying ciphertext to another chat or sender is rejected", () => {
    assert.throws(() => crypto.decryptText(ciphertext, keys, "345678901234567890", author));
    assert.throws(() => crypto.decryptText(ciphertext, keys, channel, "345678901234567890"));
});
check("Malformed, truncated and oversized envelopes are rejected", () =>
    ["[VCS1:a]", "[VCS2:abc]", "[VCS1:abc=]", "[VCS1:" + "a".repeat(18000) + "]"].forEach((text) =>
        assert.throws(() => crypto.decryptText(text, keys, channel, author)),
    ),
);
check("Invalid identifiers and excessive text are rejected", () => {
    assert.throws(() => crypto.encryptText("a", key, "bad", author));
    assert.throws(() => crypto.encryptText("a".repeat(12001), key, channel, author));
});
const fileData = Buffer.from(Array.from({ length: 8192 }, (_, i) => i % 256));
const file = crypto.encryptFile(fileData, "private-name.png", key, channel);
check("Binary files roundtrip and filename remains encrypted", () => {
    const out = crypto.decryptFile(file, keys, channel);
    assert.deepEqual(out.data, fileData);
    assert.equal(out.filename, "private-name.png");
    assert.equal(file.includes(Buffer.from("private-name.png")), false);
});
check("File authentication and chat binding", () => {
    const tampered = Buffer.from(file);
    tampered[50] ^= 1;
    assert.throws(() => crypto.decryptFile(tampered, keys, channel));
    assert.throws(() => crypto.decryptFile(file, keys, "345678901234567890"));
    assert.throws(() => crypto.decryptFile(Buffer.from("plaintext file"), keys, channel));
});
check("File paths are sanitized", () =>
    assert.equal(
        crypto.decryptFile(crypto.encryptFile(fileData, "../../bad:name.bin", key, channel), keys, channel)
            .filename,
        "bad_name.bin",
    ),
);
check("Empty files", () =>
    assert.equal(
        crypto.decryptFile(crypto.encryptFile(Buffer.alloc(0), "empty", key, channel), keys, channel).data
            .length,
        0,
    ),
);
check("Old-key messages remain readable after rotation", () =>
    assert.equal(
        crypto.decryptText(ciphertext, { ...keys, [crypto.keyId(otherKey)]: otherKey }, channel, author),
        "secret text",
    ),
);

// Bundle the real renderer module with a minimal Vencord boundary. This exercises
// the actual listeners, low-level send/edit wrappers and pre-network upload guard.
const stub = `
export default x => x;
export const ChatBarButton = () => null;
export const Button = () => null;
export const TextButton = () => null;
export const FormSwitch = () => null;
export const CopyIcon = () => null;
export const EyeIcon = () => null;
export const CloudDownloadIcon = () => null;
export const openMediaModal = () => {};
export const findComponentByCodeLazy = () => () => null;
export const findComponentLazy = () => () => null;
export const findByPropsLazy = (...props) => props.includes("isDiscordAssetUrl") ? globalThis.testUrls : props.includes("showNotification") ? globalThis.testNotifications : globalThis.testImageActions;
export const findByCodeLazy = () => async url => url;
export const MessageActions = globalThis.testActions;
export const FluxDispatcher = globalThis.testDispatcher;
export const MessageStore = { getMessage: (channel,id) => globalThis.testMessages.get(channel+":"+id), getMessages: () => ({ _array: globalThis.testRecent ?? [] }) };
export const Modal = () => null;
export const openModal = () => {};
export const ChannelStore = { getChannel: () => globalThis.testChannel ?? ({name: 'test chat'}) };
export const SelectedChannelStore = { getChannelId: () => "${channel}" };
export const showToast = text => globalThis.toasts.push(text);
export const UserStore = { getCurrentUser: () => ({ id: "${author}", premiumType: 0 }) };
export const useState = () => {};
export const useCallback = fn => fn;
export const useEffect = () => {};
export const useRef = () => {};
export const useLayoutEffect = () => {};
export const Parser = { parse: text => text };
export const addMessageAccessory = (...args) => globalThis.testAccessory = args;
export const removeMessageAccessory = () => {};
export const findGroupChildrenByChildId = (_id, children) => children;
export const Menu = { MenuItem: () => null };
export const React = {};
export const ReferencedMessageStore = globalThis.testReplyStore;
export const definePluginSettings = def => ({def});
export const OptionType = {COMPONENT:8};
export const useStateFromStores = (_stores,get) => get();
`;
const stubPath = path.join(work, "vencord-test-stub.mjs");
await writeFile(stubPath, stub);
await build({
    entryPoints: [path.join(source, "index.tsx")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(work, "plugin.mjs"),
    jsx: "transform",
    plugins: [
        {
            name: "vencord-boundary",
            setup(b) {
                b.onResolve({ filter: /^@/ }, () => ({ path: stubPath }));
                b.onResolve({ filter: /style\.css\?managed$/ }, () => ({ path: "style", namespace: "test" }));
                b.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export default '';" }));
            },
        },
    ],
});
let enabled = true;
let fail = false;
let race = false;
const sent = [];
globalThis.toasts = [];
globalThis.testUrls = { isDiscordAssetUrl: () => false, toURLSafe: (src) => new URL(src) };
globalThis.testImageActions = {
    canCopyImage: () => true,
    copyImageBlob: async () => {},
    copyImage: async () => {},
    saveImage: async () => "saved",
};
const nativeNotifications = [];
globalThis.testNotifications = {
    showNotification(...args) {
        nativeNotifications.push({ receiver: this, args });
        return "native handle";
    },
    playNotificationSound() {},
};
const originalNotification = testNotifications.showNotification;
const events = [];
globalThis.testMessages = new Map();
globalThis.testDispatcher = {
    dispatch: (event) => {
        events.push(event);
        return "dispatched";
    },
};
const originalDispatch = testDispatcher.dispatch;
globalThis.testActions = Object.fromEntries(
    ["sendMessage", "_sendMessage", "editMessage"].map((name) => [
        name,
        (...args) => {
            sent.push({ name, args });
            return "sent";
        },
    ]),
);
globalThis.testReplyStore = {
    getMessage: () => globalThis.testReference,
    getMessageByReference: () => globalThis.testReference,
    emitChange: () => {},
};
const originals = { ...globalThis.testActions };
globalThis.VencordNative = {
    pluginHelpers: {
        SharedKey: {
            channelStates: async () => ({}),
            channelInfo: async () => {
                if (fail) throw new Error("Vault unavailable");
                return { enabled };
            },
            decryptMessage: async (id, who, text) => crypto.decryptText(text, keys, id, who),
            prepareOutgoing: async (id, who, text, limit, force) => {
                if (race) return { encrypted: false, content: text };
                if (!enabled && !force) return { encrypted: false, content: text };
                let content;
                try {
                    crypto.decryptText(text, keys, id, who);
                    content = text;
                } catch {
                    content = text ? crypto.encryptText(text, key, id, who) : "";
                }
                if (content.length > limit) throw new Error("Too long");
                return { encrypted: true, content };
            },
            verifyUpload: async (id, bytes) => {
                crypto.decryptFile(Buffer.from(bytes), keys, id);
                return true;
            },
            encryptUpload: async (id, bytes, filename) => {
                try {
                    crypto.decryptFile(Buffer.from(bytes), keys, id);
                    return bytes;
                } catch {
                    return crypto.encryptFile(Buffer.from(bytes), filename, key, id);
                }
            },
        },
    },
};
const { default: plugin } = await import(pathToFileURL(path.join(work, "plugin.mjs")));
plugin.start();
check("Decrypted message body is inserted before reactions", () =>
    assert.equal(globalThis.testAccessory[2], 0),
);
const msg = () => ({
    content: "secret text",
    tts: true,
    validNonShortcutEmojis: ["emoji"],
    invalidEmojis: [],
});
let message = msg();
const options = {};
assert.equal(await plugin.onBeforeMessageSend(channel, message, options, { hasStickers: false }), undefined);
check("Composer send encrypts and removes TTS/mention metadata", () => {
    assert.equal(crypto.decryptText(message.content, keys, channel, author), "secret text");
    assert.equal(message.tts, false);
    assert.deepEqual(options.allowedMentions, { parse: [], repliedUser: false });
});
globalThis.testReference = {
    state: 0,
    message: {
        id: "456789012345678901",
        channel_id: channel,
        author: { id: author },
        content: message.content,
        attachments: [],
    },
};
const replyProjected = testReplyStore.getMessage(channel, "456789012345678901");
check("Reply excerpt uses outgoing plaintext immediately without changing stored ciphertext", () => {
    assert.equal(replyProjected.message.content, "secret text");
    assert.equal(testReference.message.content, message.content);
});
const coldCiphertext = crypto.encryptText("Cold reply excerpt", key, channel, author);
globalThis.testReference = {
    state: 0,
    message: {
        id: "456789012345678902",
        channel_id: channel,
        author: { id: author },
        content: coldCiphertext,
        attachments: [],
    },
};
check("Uncached reply never displays raw encryption envelope", () =>
    assert.equal(testReplyStore.getMessageByReference({}).message.content, ""),
);
await new Promise((r) => setTimeout(r, 0));
check("Uncached reply resolves to decrypted text while stores retain original", () => {
    assert.equal(
        testReplyStore.getMessage(channel, "456789012345678902").message.content,
        "Cold reply excerpt",
    );
    assert.equal(testReference.message.content, coldCiphertext);
});
await testActions.sendMessage(channel, message, true, options);
check("Final guard does not double-encrypt", () =>
    assert.equal(sent.at(-1).args[1].content, message.content),
);
check("Public send preserves waitForChannelReady and guards the fourth options argument", () => {
    assert.equal(sent.at(-1).args[2], true);
    assert.deepEqual(sent.at(-1).args[3].allowedMentions, { parse: [], repliedUser: false });
});
await testActions._sendMessage(channel, msg(), {});
check("Direct sends through private action are encrypted", () =>
    assert.equal(crypto.decryptText(sent.at(-1).args[1].content, keys, channel, author), "secret text"),
);
await testActions.editMessage(channel, "456789012345678901", msg());
check("Low-level edits are encrypted", () =>
    assert.equal(crypto.decryptText(sent.at(-1).args[2].content, keys, channel, author), "secret text"),
);
message = msg();
await plugin.onBeforeMessageEdit(channel, "456789012345678901", message);
check("Composer edits are encrypted", () =>
    assert.equal(crypto.decryptText(message.content, keys, channel, author), "secret text"),
);
assert.equal((await plugin.onBeforeMessageSend(channel, msg(), {}, { hasStickers: true })).cancel, true);
assert.equal(
    (
        await plugin.onBeforeMessageSend(
            channel,
            msg(),
            { alsoForwardToChannelId: channel },
            { hasStickers: false },
        )
    ).cancel,
    true,
);
assert.equal(
    (await plugin.onBeforeMessageSend(channel, { content: "a".repeat(1900) }, {}, { hasStickers: false }))
        .cancel,
    true,
);
checks += 3;
console.log("PASS stickers, forwards and oversized encrypted sends cancelled");
fail = true;
assert.equal((await plugin.onBeforeMessageSend(channel, msg(), {}, { hasStickers: false })).cancel, true);
const before = sent.length;
await assert.rejects(() => testActions.sendMessage(channel, msg(), {}));
check("Vault/IPC failure is fail-closed at both guards", () => assert.equal(sent.length, before));
fail = false;
race = true;
await assert.rejects(() => testActions.sendMessage(channel, msg(), {}));
check("Encryption-toggle race cannot send plaintext", () => assert.equal(sent.length, before));
race = false;
let cancelled = false;
const upload = {
    channelId: channel,
    item: { file: { name: "encrypted.vcs", size: file.length, arrayBuffer: async () => file } },
    cancel() {
        cancelled = true;
    },
};
await plugin.guardUploads([upload]);
check("Authenticated encrypted files accepted with generic metadata", () => {
    assert.equal(upload.filename, "encrypted.vcs");
    assert.equal(upload.description, null);
    assert.equal(cancelled, false);
});
const ordinary = {
    ...upload,
    item: { file: { name: "photo.png", size: fileData.length, arrayBuffer: async () => fileData } },
};
await plugin.guardUploads([ordinary]);
const ordinaryBundle = Buffer.from(await ordinary.item.file.arrayBuffer());
check("Ordinary attachments auto-encrypt before network boundary", () => {
    assert.deepEqual(crypto.decryptFile(ordinaryBundle, keys, channel).data, fileData);
    assert.equal(ordinary.item.file.name, "encrypted.vcs");
    assert.equal(cancelled, false);
});
const zipBytes = Buffer.from([0x50, 0x4b, 3, 4, ...Buffer.from("synthetic archive payload")]);
const zipUpload = {
    channelId: channel,
    status: "NOT_STARTED",
    item: { file: new File([zipBytes], "SharedKey-friend-kit.zip", { type: "application/zip" }) },
    cancel() {
        cancelled = true;
    },
};
await plugin.guardUploads([zipUpload]);
const uploadedZip = Buffer.from(await zipUpload.item.file.arrayBuffer());
check("ZIP network payload has authenticated VCSFILE1 header and roundtrips to the exact ZIP", () => {
    assert.equal(uploadedZip.subarray(0, 8).toString(), "VCSFILE1");
    const decoded = crypto.decryptFile(uploadedZip, keys, channel);
    assert.deepEqual(decoded.data, zipBytes);
    assert.equal(decoded.filename, "SharedKey-friend-kit.zip");
});
const alreadyEncryptedFile = zipUpload.item.file;
zipUpload.status = "COMPLETED";
await plugin.guardUploads([zipUpload]);
const repeatedZipBytes = Buffer.from(await zipUpload.item.file.arrayBuffer());
check("Completed upload encrypted by this build is not replaced after upload", () => {
    assert.equal(zipUpload.item.file, alreadyEncryptedFile);
    assert.deepEqual(repeatedZipBytes, uploadedZip);
});
const originalUploadInfo = VencordNative.pluginHelpers.SharedKey.channelInfo;
VencordNative.pluginHelpers.SharedKey.channelInfo = async () => ({
    enabled: true,
    method: "automatic",
    fingerprint: "saved",
    identityChanged: true,
});
await assert.rejects(() => plugin.guardUploads([zipUpload]), /identity key changed/);
check("A changed identity blocks an already-prepared upload before its cached fast path", () => {
    assert.equal(cancelled, true);
    assert.equal(zipUpload.item.file, alreadyEncryptedFile);
});
cancelled = false;
VencordNative.pluginHelpers.SharedKey.channelInfo = async () => ({
    enabled: true,
    method: "password",
    fingerprint: "",
});
await assert.rejects(() => plugin.guardUploads([zipUpload]), /Finish encryption setup/);
check("Switching to an unconfigured method also blocks prepared uploads", () =>
    assert.equal(cancelled, true),
);
cancelled = false;
VencordNative.pluginHelpers.SharedKey.channelInfo = originalUploadInfo;
const directPatch = plugin.patches.find((p) => p.find === "_uploadFileToCloud - responseUrl is not set");
const directMethod =
    'async upload(){this.status="STARTED";this.sentBytes=new Uint8Array(await this.item.file.arrayBuffer());this.status="COMPLETED";}';
const patchedMethod = directMethod.replace(
    directPatch.replacement.match,
    directPatch.replacement.replace.replaceAll("$self", "plugin"),
);
const DirectUpload = new Function(
    "plugin",
    `return class { constructor(file){this.channelId="${channel}";this.item={file};this.status="NOT_STARTED";}cancel(){}${patchedMethod}}`,
)(plugin);
const directUpload = new DirectUpload(new File([zipBytes], "SharedKey-friend-kit.zip"));
await directUpload.upload();
check("Direct individual upload guard encrypts ZIP bytes before network snapshot", () => {
    assert.equal(Buffer.from(directUpload.sentBytes).subarray(0, 8).toString(), "VCSFILE1");
    assert.deepEqual(crypto.decryptFile(Buffer.from(directUpload.sentBytes), keys, channel).data, zipBytes);
});
const stale = {
    channelId: channel,
    status: "COMPLETED",
    item: { file: new File([zipBytes], "SharedKey-friend-kit.zip") },
    cancel() {
        cancelled = true;
    },
};
await assert.rejects(() => plugin.guardUploads([stale]), /before encryption/);
check("Already uploaded plaintext is rejected rather than renamed", () =>
    assert.equal(stale.item.file.name, "SharedKey-friend-kit.zip"),
);
enabled = false;
const plainZip = {
    channelId: channel,
    status: "NOT_STARTED",
    item: { file: new File([zipBytes], "SharedKey-friend-kit.zip") },
    cancel() {},
};
await plugin.guardUploads([plainZip]);
check("Encryption-off ZIP keeps original filename and ZIP bytes", () =>
    assert.equal(plainZip.item.file.name, "SharedKey-friend-kit.zip"),
);
assert.deepEqual(Buffer.from(await plainZip.item.file.arrayBuffer()), zipBytes);
enabled = true;
const fake = {
    ...upload,
    item: { file: { name: "fake.vcs", size: 4, arrayBuffer: async () => Buffer.from("fake") } },
};
await plugin.guardUploads([fake]);
const fakeBundle = Buffer.from(await fake.item.file.arrayBuffer());
check("Renamed plaintext is encrypted too", () =>
    assert.equal(crypto.decryptFile(fakeBundle, keys, channel).data.toString(), "fake"),
);
const oldHelper = VencordNative.pluginHelpers.SharedKey.encryptUpload;
VencordNative.pluginHelpers.SharedKey.encryptUpload = async () => {
    throw new Error("Encryption unavailable");
};
await assert.rejects(() =>
    plugin.guardUploads([
        {
            ...upload,
            item: { file: { name: "photo.png", size: 4, arrayBuffer: async () => Buffer.from("fake") } },
        },
    ]),
);
check("Attachment encryption failure cancels upload", () => assert.equal(cancelled, true));
VencordNative.pluginHelpers.SharedKey.encryptUpload = oldHelper;
enabled = false;
await testActions.sendMessage(channel, msg(), {});
check("Unprotected chat sends retain ordinary text", () =>
    assert.equal(sent.at(-1).args[1].content, "secret text"),
);
const editStored = {
    id: "456789012345678901",
    channel_id: channel,
    author: { id: author },
    content: crypto.encryptText("Editable original", key, channel, author),
    attachments: [],
};
testMessages.set(channel + ":" + editStored.id, editStored);
const startEdit = {
    type: "MESSAGE_START_EDIT",
    channelId: channel,
    messageId: editStored.id,
    content: editStored.content,
};
await testDispatcher.dispatch(startEdit);
check("Edit box receives plaintext while original event and store retain ciphertext", () => {
    assert.equal(events.at(-1).content, "Editable original");
    assert.equal(startEdit.content, editStored.content);
});
await testActions.editMessage(channel, editStored.id, { content: "Changed while toggle off" });
check("Editing encrypted history stays encrypted with chat toggle off", () =>
    assert.equal(
        crypto.decryptText(sent.at(-1).args[2].content, keys, channel, author),
        "Changed while toggle off",
    ),
);
const editDraft = { content: "Composer edit while off" };
await plugin.onBeforeMessageEdit(channel, editStored.id, editDraft);
check("Composer edit guard also protects encrypted history when toggle is off", () =>
    assert.equal(crypto.decryptText(editDraft.content, keys, channel, author), "Composer edit while off"),
);
const receive = {
    ...editStored,
    id: "456789012345678903",
    content: crypto.encryptText("Readable notification", key, channel, author),
};
testDispatcher.dispatch({ type: "MESSAGE_CREATE", message: receive });
const optionsRef = { onClick() {}, sound: true };
const notification = {
    type: "NOTIFICATION_CREATE",
    body: receive.content,
    title: "Friend",
    options: optionsRef,
};
await testDispatcher.dispatch(notification);
check("Native notification decrypts before display without changing options or wire event", () => {
    assert.equal(events.at(-1).body, "Readable notification");
    assert.equal(events.at(-1).options, optionsRef);
    assert.equal(notification.body, receive.content);
});
const nativeTracking = { channel_id: channel, message_id: receive.id, notif_type: "MESSAGE_CREATE" };
const nativeOptions = { sound: "message3", onClick() {}, onClose() {} };
assert.equal(
    await testNotifications.showNotification(
        "avatar.png",
        "Friend",
        receive.content,
        nativeTracking,
        nativeOptions,
    ),
    "native handle",
);
check(
    "Direct NotificationStore path decrypts while preserving the native handle, receiver, callbacks and tracking",
    () => {
        const call = nativeNotifications.at(-1);
        assert.equal(call.args[2], "Readable notification");
        assert.equal(call.receiver, testNotifications);
        assert.equal(call.args[3], nativeTracking);
        assert.equal(call.args[4], nativeOptions);
    },
);
await testNotifications.showNotification("avatar.png", "Friend", "[VCS1:UNAVAILABLE]", {}, nativeOptions);
check("Direct native notifications with missing keys never show ciphertext", () =>
    assert.equal(nativeNotifications.at(-1).args[2], "Encrypted message"),
);
assert.equal(
    testNotifications.showNotification("avatar.png", "Friend", "normal text", {}, nativeOptions),
    "native handle",
);
check("Ordinary direct notifications retain synchronous behavior", () =>
    assert.equal(nativeNotifications.at(-1).args[2], "normal text"),
);
const coldDirect = {
    ...receive,
    id: "456789012345678905",
    content: crypto.encryptText("Cold direct notification", key, channel, author),
};
testDispatcher.dispatch({ type: "MESSAGE_CREATE", message: coldDirect });
await testNotifications.showNotification("avatar.png", "Friend", coldDirect.content, {}, nativeOptions);
check("Direct notifications wait for first-time decryption instead of displaying a ciphertext frame", () =>
    assert.equal(nativeNotifications.at(-1).args[2], "Cold direct notification"),
);
await testDispatcher.dispatch({ ...notification, body: receive.content.slice(0, 34) + "…" });
check("Truncated ciphertext notification resolves using incoming message context", () =>
    assert.equal(events.at(-1).body, "Readable notification"),
);
await testDispatcher.dispatch({ ...notification, body: "[VCS1:UNAVAILABLE]" });
check("Unknown-key notification never displays a raw envelope", () =>
    assert.equal(events.at(-1).body, "Encrypted message"),
);
const ordinaryNotification = { type: "NOTIFICATION_CREATE", body: "Ordinary notification" };
testDispatcher.dispatch(ordinaryNotification);
check("Ordinary notification dispatch is unchanged and synchronous", () =>
    assert.equal(events.at(-1), ordinaryNotification),
);
const setupWire = "[VCKX1:PUBLIC_SETUP_PACKET]";
testDispatcher.dispatch({ ...ordinaryNotification, body: setupWire });
check("Setup notifications never expose wire packets", () =>
    assert.equal(events.at(-1).body, "Encryption setup"),
);
globalThis.testReference = { state: 0, message: { ...receive, content: setupWire, attachments: [] } };
check("Setup reply excerpts use a short label without mutating the original", () => {
    assert.equal(testReplyStore.getMessage(channel, receive.id).message.content, "Encryption setup");
    assert.equal(testReference.message.content, setupWire);
});
testMessages.set(channel + ":" + receive.id, { ...receive, content: setupWire });
const editsBefore = events.length;
testDispatcher.dispatch({
    type: "MESSAGE_START_EDIT",
    channelId: channel,
    messageId: receive.id,
    content: setupWire,
});
check("Setup packets cannot be edited into an invalid handshake", () =>
    assert.equal(events.length, editsBefore),
);
enabled = true;
globalThis.testChannel = { type: 1, recipients: ["345678901234567890"] };
const controlMessage = {
    ...receive,
    id: "456789012345678999",
    content: setupWire,
    author: { id: "345678901234567890" },
};
const generatedControl = "[VCKX1:ISSUED_SETUP_PACKET]";
const protocolCalls = [];
const helper = VencordNative.pluginHelpers.SharedKey;
helper.handleExchange = async (...args) => {
    protocolCalls.push(args);
    return { info: { enabled: true, method: "automatic", color: "#7d52ff" }, outgoing: generatedControl };
};
const originalPrepare = helper.prepareOutgoing;
helper.prepareOutgoing = async (id, who, content, ...args) =>
    content === generatedControl ? { content, encrypted: true } : originalPrepare(id, who, content, ...args);
plugin.flux.MESSAGE_CREATE({ message: controlMessage });
plugin.flux.MESSAGE_CREATE({ message: controlMessage });
await new Promise(setImmediate);
check("Incoming DM setup sends a native-issued response once through the guarded Discord action", () => {
    assert.equal(protocolCalls.length, 1);
    assert.deepEqual(protocolCalls[0].slice(0, 5), [
        channel,
        author,
        "345678901234567890",
        "345678901234567890",
        setupWire,
    ]);
    assert.equal(sent.at(-1).args[1].content, generatedControl);
    assert.equal(sent.at(-1).args[2], true);
    assert.deepEqual(sent.at(-1).args[3].allowedMentions, { parse: [], repliedUser: false });
});
globalThis.testRecent = [controlMessage];
plugin.flux.MESSAGE_LOAD_SUCCESS({ channelId: channel });
plugin.flux.MESSAGE_CREATE({ message: { ...controlMessage, author: { id: author } } });
globalThis.testChannel = { type: 0, recipients: ["345678901234567890"] };
plugin.flux.MESSAGE_CREATE({ message: { ...controlMessage, id: "456789012345679000" } });
await new Promise(setImmediate);
check("History duplicates, own messages and server channels do not trigger extra setup sends", () =>
    assert.equal(protocolCalls.length, 1),
);
delete globalThis.testChannel;
plugin.stop();
check("Disabling plugin restores notification/edit dispatch", () =>
    assert.equal(testDispatcher.dispatch, originalDispatch),
);
check("Disabling plugin restores Discord's native notification function", () =>
    assert.equal(testNotifications.showNotification, originalNotification),
);
check("Disabling plugin restores original action functions", () =>
    assert.deepEqual(globalThis.testActions, originals),
);

// Exercise the real native handlers, using an isolated vault and a simulated OS
// credential-encryption boundary. No user credentials/settings are accessed.
const nativeDir = path.join(work, `native-test-${Date.now()}`);
await mkdir(nativeDir, { recursive: true });
const storageKey = randomBytes(32);
let storageAvailable = true;
globalThis.testElectron = {
    safeStorage: {
        isEncryptionAvailable: () => storageAvailable,
        getSelectedStorageBackend: () => "test",
        encryptString: (text) => {
            const iv = randomBytes(12);
            const cipher = createCipheriv("aes-256-gcm", storageKey, iv);
            const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
            return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
        },
        decryptString: (bytes) => {
            const cipher = createDecipheriv("aes-256-gcm", storageKey, bytes.subarray(0, 12));
            cipher.setAuthTag(bytes.subarray(12, 28));
            return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
        },
    },
    BrowserWindow: { fromWebContents: () => ({}) },
    dialog: {
        showOpenDialog: async () => ({ canceled: true }),
        showSaveDialog: async () => ({ canceled: true }),
    },
};
const electronStub = path.join(work, "electron-test-stub.mjs");
const cspStub = path.join(work, "csp-test-stub.mjs");
await writeFile(cspStub, "export const CspPolicies = {};");
const constantsStub = path.join(work, "constants-test-stub.mjs");
await writeFile(electronStub, "export const {safeStorage, BrowserWindow, dialog} = globalThis.testElectron;");
await writeFile(constantsStub, `export const SETTINGS_DIR = ${JSON.stringify(nativeDir)};`);
await build({
    entryPoints: [path.join(source, "native.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(work, "native.mjs"),
    plugins: [
        {
            name: "native-boundary",
            setup(b) {
                b.onResolve({ filter: /^electron$/ }, () => ({ path: electronStub }));
                b.onResolve({ filter: /^@main\/csp$/ }, () => ({ path: cspStub }));
                b.onResolve({ filter: /^@main\/utils\/constants$/ }, () => ({ path: constantsStub }));
            },
        },
    ],
});
const nativeUrl = pathToFileURL(path.join(work, "native.mjs"));
const native = await import(nativeUrl);
native.saveKey(null, channel, key);
check("Startup rendering snapshot contains state/color but no saved keys", () => {
    assert.deepEqual(native.channelStates(null)[channel], { enabled: true, color: "#7d52ff" });
    assert.equal(JSON.stringify(native.channelStates(null)).includes(key), false);
});
check("Default encrypted message color is purple", () =>
    assert.equal(native.channelInfo(null, channel).color, "#7d52ff"),
);
native.setColor(null, channel, "#9876ab");
check("Message color is saved per chat and validated", () => {
    assert.equal(native.channelInfo(null, channel).color, "#9876ab");
    assert.throws(() => native.setColor(null, channel, "purple;url(bad)"));
});
const autoFile = native.encryptUpload(null, channel, fileData, "photo.png");
check("Native auto-upload encryption retains original file inside ciphertext", () => {
    const data = crypto.decryptFile(Buffer.from(autoFile), keys, channel);
    assert.equal(data.filename, "photo.png");
    assert.deepEqual(data.data, fileData);
});
check("Existing authenticated encrypted file is not encrypted twice", () =>
    assert.deepEqual(native.encryptUpload(null, channel, autoFile, "encrypted.vcs"), autoFile),
);
const attachmentAddress = `https://cdn.discordapp.com/attachments/${channel}/456789012345678901/encrypted.vcs?ex=signature`;
const oldFetch = globalThis.fetch;
let requested = 0;
globalThis.fetch = async (url, init) => {
    requested++;
    assert.equal(url, attachmentAddress);
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    return new Response(autoFile, { headers: { "content-length": String(autoFile.byteLength) } });
};
const receivedFile = await native.decryptAttachment(null, channel, attachmentAddress);
check("Incoming attachments decrypt automatically with original filename", () => {
    assert.deepEqual(Buffer.from(receivedFile.data), fileData);
    assert.equal(receivedFile.filename, "photo.png");
    assert.equal(receivedFile.mime, "application/octet-stream");
});
for (const bad of [
    "http://cdn.discordapp.com/attachments/" + channel + "/123456789/file.vcs",
    "https://127.0.0.1/attachments/" + channel + "/123456789/file.vcs",
    "https://cdn.discordapp.com.attacker.test/attachments/" + channel + "/123456789/file.vcs",
    "https://user:password@cdn.discordapp.com/attachments/" + channel + "/123456789/file.vcs",
    "https://cdn.discordapp.com/attachments/345678901234567890/123456789/file.vcs",
]) {
    await assert.rejects(() => native.decryptAttachment(null, channel, bad));
}
check("Attachment fetch rejects other hosts, credentials, HTTP and other chats before network", () =>
    assert.equal(requested, 1),
);
globalThis.fetch = async () => new Response(zipBytes);
check("Unencrypted ZIP mislabeled vcs is recognized as ordinary without a decrypt error", () => {});
assert.equal((await native.decryptAttachment(null, channel, attachmentAddress)).encrypted, false);
const gifBytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const gifEncrypted = native.encryptUpload(null, channel, gifBytes, "animation.gif");
globalThis.fetch = async () => new Response(gifEncrypted);
const gifReceived = await native.decryptAttachment(null, channel, attachmentAddress);
check("GIF bytes are preserved and identified for animated preview", () => {
    assert.equal(gifReceived.mime, "image/gif");
    assert.deepEqual(Buffer.from(gifReceived.data), gifBytes);
});
const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0S8AAAAASUVORK5CYII=",
    "base64",
);
globalThis.fetch = async () => new Response(native.encryptUpload(null, channel, pngBytes, "picture.png"));
check("PNG is recognized by decrypted bytes", () => {});
assert.equal((await native.decryptAttachment(null, channel, attachmentAddress)).mime, "image/png");
const tamperedAttachment = Uint8Array.from(gifEncrypted);
tamperedAttachment[tamperedAttachment.length - 1] ^= 1;
globalThis.fetch = async () => new Response(tamperedAttachment);
await assert.rejects(() => native.decryptAttachment(null, channel, attachmentAddress));
checks++;
console.log("PASS tampered attachment fails before returning plaintext");
globalThis.fetch = async () =>
    new Response(gifEncrypted, { headers: { "content-length": String(64 * 1024 * 1024 + 4201) } });
await assert.rejects(() => native.decryptAttachment(null, channel, attachmentAddress));
checks++;
console.log("PASS oversized advertised attachment rejected");
globalThis.fetch = async () => new Response("expired", { status: 403 });
await assert.rejects(() => native.decryptAttachment(null, channel, attachmentAddress));
checks++;
console.log("PASS expired/unavailable attachment reported");
globalThis.fetch = oldFetch;
check("Native file-only send keeps an empty caption without a text envelope", () => {
    assert.deepEqual(native.prepareOutgoing(null, channel, author, "", 2000), {
        content: "",
        encrypted: true,
    });
    assert.equal(native.prepareOutgoing(null, channel, author, "", 2000, true).content, "");
});
const historicalEmpty = crypto.encryptText("", key, channel, author);
check("Existing encrypted empty captions still decrypt for old previews", () =>
    assert.equal(native.decryptMessage(null, channel, author, historicalEmpty), ""),
);
let prepared = native.prepareOutgoing(null, channel, author, "secret", 2000);
check("Native handlers encrypt and decrypt", () =>
    assert.equal(native.decryptMessage(null, channel, author, prepared.content), "secret"),
);
const saved = await readFile(path.join(nativeDir, "sharedkey-vault.bin"));
check("Vault persistence does not contain plaintext keys", () =>
    assert.equal(saved.includes(Buffer.from(key)), false),
);
const reloaded = await import(nativeUrl + "?reload");
check("Keys and enabled state survive native reload", () => {
    assert.equal(reloaded.revealKey(null, channel), key);
    assert.equal(reloaded.channelInfo(null, channel).enabled, true);
});
const secondChannel = "345678901234567890";
native.saveKey(null, secondChannel, otherKey);
native.toggleEnabled(null, channel);
check("Toggle changes only its own chat", () => {
    assert.equal(native.channelInfo(null, channel).enabled, false);
    assert.equal(native.channelInfo(null, secondChannel).enabled, true);
});
check("Per-chat colors stay independent", () =>
    assert.equal(native.channelInfo(null, secondChannel).color, "#7d52ff"),
);
native.toggleEnabled(null, channel);
check("Toggle restores encryption without changing either key", () => {
    assert.equal(native.channelInfo(null, channel).enabled, true);
    assert.equal(native.revealKey(null, channel), key);
    assert.equal(native.revealKey(null, secondChannel), otherKey);
});
check("Unconfigured chat requests setup without toggling other chats", () => {
    assert.equal(native.toggleEnabled(null, "456789012345678901").needsKey, true);
    assert.equal(native.channelInfo(null, channel).enabled, true);
});
native.setEnabled(null, secondChannel, false);
native.saveKey(null, secondChannel, key);
check("Saving a replacement key preserves that chat's toggle", () => {
    assert.equal(native.channelInfo(null, secondChannel).enabled, false);
    assert.equal(native.channelInfo(null, channel).enabled, true);
});
native.saveKey(null, channel, otherKey);
check("Key rotation preserves the selected message color", () =>
    assert.equal(native.channelInfo(null, channel).color, "#9876ab"),
);
check("Native key rotation preserves old message decryption", () =>
    assert.equal(native.decryptMessage(null, channel, author, prepared.content), "secret"),
);
native.setEnabled(null, channel, false);
check("Native disabled state preserves decryption and ordinary outgoing text", () => {
    assert.equal(native.prepareOutgoing(null, channel, author, "ordinary").content, "ordinary");
    assert.equal(native.decryptMessage(null, channel, author, prepared.content), "secret");
});
check("Native forced edit encryption works with the toggle off", () =>
    assert.equal(
        native.decryptMessage(
            null,
            channel,
            author,
            native.prepareOutgoing(null, channel, author, "Forced edit", 2000, true).content,
        ),
        "Forced edit",
    ),
);
native.setEnabled(null, channel, true);
check("Native oversize rejection and unknown channel behavior", () => {
    assert.throws(() => native.prepareOutgoing(null, channel, author, "x".repeat(1900), 2000));
    assert.equal(native.channelInfo(null, "567890123456789012").enabled, false);
});
storageAvailable = false;
check("Unavailable OS credential storage blocks native handlers", () => {
    assert.throws(() => native.channelInfo(null, channel));
    assert.throws(() => native.prepareOutgoing(null, channel, author, "secret"));
});
storageAvailable = true;
const inputPath = path.join(nativeDir, "original.bin");
const encryptedPath = path.join(nativeDir, "encrypted.vcs");
const decryptedPath = path.join(nativeDir, "decrypted.bin");
testElectron.dialog.showSaveDialog = async (_window, props) => {
    assert.equal(props.defaultPath, "notes.txt");
    return { canceled: false, filePath: path.join(nativeDir, "notes.txt") };
};
await native.saveDecryptedAttachment(
    { sender: {} },
    "../../notes.txt",
    new Uint8Array(Buffer.from("decrypted notes")),
);
assert.equal(await readFile(path.join(nativeDir, "notes.txt"), "utf8"), "decrypted notes");
checks++;
console.log("PASS decrypted file save uses original safe filename and explicit save dialog");
await writeFile(inputPath, fileData);
testElectron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [inputPath] });
testElectron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: encryptedPath });
await native.fileTool({ sender: {} }, channel, false);
testElectron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [encryptedPath] });
testElectron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: decryptedPath });
await native.fileTool({ sender: {} }, channel, true);
check("Native file dialogs produce roundtrippable encrypted copies", () => {});
assert.deepEqual(await readFile(decryptedPath), fileData);
assert.deepEqual(await readFile(inputPath), fileData);
check("File encryption preserves original", () => {});
testElectron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: encryptedPath });
await assert.rejects(() => native.fileTool({ sender: {} }, channel, true));
checks++;
console.log("PASS same-path overwrite rejected");
await writeFile(path.join(nativeDir, "sharedkey-vault.bin"), testElectron.safeStorage.encryptString("[]"));
const corrupt = await import(nativeUrl + "?corrupt");
check("Corrupted vault remains fail-closed across repeated calls", () => {
    assert.throws(() => corrupt.channelInfo(null, channel));
    assert.throws(() => corrupt.channelInfo(null, channel));
});
console.log(`${checks} checks passed.`);
await writeFile(
    path.join(work, "verification.json"),
    JSON.stringify(
        {
            checks,
            result: "passed",
            verifiedAt: new Date().toISOString(),
            scope: "crypto and mocked Vencord boundaries; live Discord not yet tested",
        },
        null,
        2,
    ),
);
