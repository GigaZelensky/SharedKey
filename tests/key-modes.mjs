import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createPrivateKey, randomBytes, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, ".test-output", `key-modes-${Date.now()}`);
await mkdir(work, { recursive: true });
await build({
    entryPoints: [path.join(root, "src/keyExchange.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(work, "exchange.mjs"),
});
await build({
    entryPoints: [path.join(root, "src/crypto.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(work, "crypto.mjs"),
});
const kx = await import(pathToFileURL(path.join(work, "exchange.mjs")));
const crypto = await import(pathToFileURL(path.join(work, "crypto.mjs")));
const channel = "123456789012345678";
const alice = "234567890123456789";
const bob = "345678901234567890";
const now = Date.now();
let checks = 0;
async function check(label, fn) {
    await fn();
    checks++;
    console.log(`PASS ${label}`);
}
function unpack(wire) {
    return JSON.parse(Buffer.from(wire.slice(kx.EXCHANGE_PREFIX.length, -1), "base64url").toString());
}
function repack(fields) {
    return kx.EXCHANGE_PREFIX + Buffer.from(JSON.stringify(fields)).toString("base64url") + "]";
}
function resign(wire, state, edit) {
    const fields = unpack(wire);
    edit(fields);
    fields[9] = sign(
        null,
        Buffer.from(JSON.stringify(fields.slice(0, 9))),
        createPrivateKey({
            key: Buffer.from(state.privateIdentity, "base64url"),
            type: "pkcs8",
            format: "der",
        }),
    ).toString("base64url");
    return repack(fields);
}
let a = kx.createExchange(alice, bob);
let b = kx.createExchange(bob, alice);
const start = await kx.beginExchange(a, channel, now);
a = start.state;
const response = kx.receiveExchange(b, channel, alice, start.outgoing, now);
b = response.state;
const acknowledgement = kx.receiveExchange(a, channel, bob, response.outgoing, now);
a = acknowledgement.state;
await check("RSA exchange has four signed, bounded flights and commits only after key confirmation", () => {
    assert.equal(response.key, undefined);
    assert.equal(acknowledgement.key, undefined);
    assert.equal(Buffer.from(unpack(response.outgoing)[8][0], "base64url").length, 384);
    for (const wire of [start.outgoing, response.outgoing, acknowledgement.outgoing])
        assert.ok(wire.length <= 2000);
    for (const state of [a, b]) kx.validateExchangeState(state);
});
await check("Discord packets contain no private identity, private transport, or plaintext AES key", () => {
    for (const wire of [start.outgoing, response.outgoing, acknowledgement.outgoing]) {
        const payload = JSON.stringify(unpack(wire));
        for (const secret of [
            a.privateIdentity,
            b.privateIdentity,
            start.state.pending.privateTransport,
            a.pending.key,
        ])
            assert.equal(payload.includes(secret), false);
    }
});
await check("Wrong channel, author, recipient and expired sessions are rejected", () => {
    assert.throws(() =>
        kx.receiveExchange(kx.createExchange(bob, alice), "456789012345678901", alice, start.outgoing, now),
    );
    assert.throws(() => kx.receiveExchange(kx.createExchange(bob, alice), channel, bob, start.outgoing, now));
    assert.throws(() =>
        kx.receiveExchange(
            kx.createExchange("456789012345678901", alice),
            channel,
            alice,
            start.outgoing,
            now,
        ),
    );
    assert.throws(() => kx.receiveExchange(b, channel, alice, start.outgoing, now + 600001));
});
await check("Unsigned tampering and correctly signed wrong key confirmations are rejected", () => {
    const fields = unpack(response.outgoing);
    fields[8][2] = randomBytes(32).toString("base64url");
    assert.throws(() => kx.receiveExchange(start.state, channel, bob, repack(fields), now));
    assert.throws(() =>
        kx.receiveExchange(
            start.state,
            channel,
            bob,
            resign(response.outgoing, b, (p) => (p[8][2] = randomBytes(32).toString("base64url"))),
            now,
        ),
    );
    assert.throws(() =>
        kx.receiveExchange(
            b,
            channel,
            alice,
            resign(acknowledgement.outgoing, a, (p) => (p[8][1] = randomBytes(32).toString("base64url"))),
            now,
        ),
    );
});
await check("An unrelated session cannot complete a pending exchange", async () => {
    const another = await kx.beginExchange(kx.createExchange(alice, bob), channel, now);
    const reply = kx.receiveExchange(kx.createExchange(bob, alice), channel, alice, another.outgoing, now);
    assert.throws(() => kx.receiveExchange(start.state, channel, bob, reply.outgoing, now));
});
const finished = kx.receiveExchange(b, channel, alice, acknowledgement.outgoing, now);
b = finished.state;
const complete = kx.receiveExchange(a, channel, bob, finished.outgoing, now);
a = complete.state;
await check("Both clients obtain the same AES key and identity code", () => {
    assert.equal(complete.key, finished.key);
    assert.equal(kx.exchangeFingerprint(a), kx.exchangeFingerprint(b));
    assert.equal(kx.exchangeFingerprint(a).length, 64);
    const wire = crypto.encryptText("hello", complete.key, channel, alice);
    assert.equal(
        crypto.decryptText(wire, { [crypto.keyId(finished.key)]: finished.key }, channel, alice),
        "hello",
    );
    const file = crypto.encryptFile(Buffer.from("file"), "example.txt", complete.key, channel);
    assert.equal(
        crypto.decryptFile(file, { [crypto.keyId(finished.key)]: finished.key }, channel).filename,
        "example.txt",
    );
    assert.equal(a.pending, undefined);
    assert.equal(b.pending.key, undefined);
    kx.validateExchangeState(a);
    kx.validateExchangeState(b);
});
await check("Retries reuse packets, and completed replay cannot rekey", () => {
    assert.equal(
        kx.receiveExchange(response.state, channel, alice, start.outgoing, now).outgoing,
        response.outgoing,
    );
    assert.equal(
        kx.receiveExchange(acknowledgement.state, channel, bob, response.outgoing, now).outgoing,
        acknowledgement.outgoing,
    );
    assert.equal(
        kx.receiveExchange(b, channel, alice, acknowledgement.outgoing, now).outgoing,
        finished.outgoing,
    );
    assert.equal(kx.receiveExchange(b, channel, alice, start.outgoing, now).key, undefined);
    assert.equal(kx.receiveExchange(a, channel, bob, finished.outgoing, now).key, undefined);
});
await check("A replacement identity is rejected even with a valid signature", async () => {
    const impostor = await kx.beginExchange(kx.createExchange(alice, bob), channel, now);
    assert.throws(
        () => kx.receiveExchange(b, channel, alice, impostor.outgoing, now),
        /identity key changed/,
    );
});
await check("A completed responder accepts a new exchange immediately", async () => {
    const next = await kx.beginExchange(a, channel, now);
    const response = kx.receiveExchange(b, channel, alice, next.outgoing, now);
    assert.ok(response.outgoing);
    assert.equal(response.state.pending.session, next.state.pending.session);
});
await check("Simultaneous starts converge on one session", async () => {
    const aa = await kx.beginExchange(a, channel, now);
    const bb = await kx.beginExchange(b, channel, now);
    assert.equal(kx.receiveExchange(aa.state, channel, bob, bb.outgoing, now).outgoing, undefined);
    const rr = kx.receiveExchange(bb.state, channel, alice, aa.outgoing, now);
    const ack = kx.receiveExchange(aa.state, channel, bob, rr.outgoing, now);
    const ff = kx.receiveExchange(rr.state, channel, alice, ack.outgoing, now);
    assert.equal(kx.receiveExchange(ack.state, channel, bob, ff.outgoing, now).key, ff.key);
});
await check("Malformed packets and corrupt identity pairs are rejected", () => {
    for (const wire of [
        "[VCKX1:a]",
        "[VCKX1:" + "a".repeat(2100) + "]",
        repack({ invalid: true }),
        repack([...unpack(start.outgoing), 0]),
    ])
        assert.throws(() => kx.receiveExchange(b, channel, alice, wire, now));
    assert.throws(() => kx.validateExchangeState({ ...a, privateIdentity: b.privateIdentity }));
});
const passphrase = "  my friend 🦋\nKeep CASE  ";
const passwordKey = await crypto.passwordKey(passphrase, channel);
await check("Password derivation matches an independent Python hashlib fixture", () => {
    assert.equal(passwordKey, "vcs1_WKxutb5i82aiwuNOhbnDEZNToZ0x31uFWt89TI8ndjs");
});
await check("Password derivation agrees and preserves whitespace, case and Unicode", async () => {
    assert.equal(await crypto.passwordKey(passphrase, channel), passwordKey);
    assert.notEqual(await crypto.passwordKey(passphrase.trim(), channel), passwordKey);
    assert.notEqual(await crypto.passwordKey(passphrase.toLowerCase(), channel), passwordKey);
    assert.notEqual(await crypto.passwordKey(passphrase, "456789012345678901"), passwordKey);
    assert.equal(crypto.parseKey(await crypto.passwordKey(" ", channel)).length, 32);
    await assert.rejects(crypto.passwordKey("", channel));
    await assert.rejects(crypto.passwordKey("x".repeat(4097), channel));
});

// Two isolated main-process instances model separate installations. The fake
// Electron boundary encrypts real vault bytes; no user settings are accessed.
const storageKey = randomBytes(32);
globalThis.keyModeElectron = {
    safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "test",
        encryptString: (text) => {
            const iv = randomBytes(12);
            const cipher = createCipheriv("aes-256-gcm", storageKey, iv);
            const body = Buffer.concat([cipher.update(text), cipher.final()]);
            return Buffer.concat([iv, cipher.getAuthTag(), body]);
        },
        decryptString: (bytes) => {
            const cipher = createDecipheriv("aes-256-gcm", storageKey, bytes.subarray(0, 12));
            cipher.setAuthTag(bytes.subarray(12, 28));
            return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
        },
    },
    BrowserWindow: {},
    dialog: {},
};
async function client(name) {
    const dir = path.join(work, name);
    await mkdir(dir, { recursive: true });
    const outfile = path.join(dir, "native.mjs");
    await build({
        entryPoints: [path.join(root, "src/native.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        plugins: [
            {
                name: "isolated-native",
                setup(b) {
                    b.onResolve({ filter: /^electron$|^@main\// }, (args) => ({
                        path: args.path,
                        namespace: "stub",
                    }));
                    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
                        contents:
                            args.path === "electron"
                                ? "export const {safeStorage, BrowserWindow, dialog} = globalThis.keyModeElectron;"
                                : args.path.endsWith("constants")
                                  ? `export const SETTINGS_DIR = ${JSON.stringify(dir)};`
                                  : "export const CspPolicies = {};",
                    }));
                },
            },
        ],
    });
    return { native: await import(pathToFileURL(outfile)), dir, outfile };
}
const ca = await client("alice");
const cb = await client("bob");
const na = ca.native;
const nb = cb.native;
const manual = crypto.generateKey();
na.saveKey(null, channel, manual);
await na.setMethod(null, channel, "automatic", alice, bob);
await check(
    "Automatic setup blocks drafts/uploads until ready and only allows issued control packets",
    () => {
        assert.throws(() => na.prepareOutgoing(null, channel, alice, "private draft"), /Finish/);
        assert.throws(() => na.encryptUpload(null, channel, new Uint8Array([1]), "private.txt"), /Finish/);
        assert.throws(() => na.prepareOutgoing(null, channel, alice, start.outgoing), /Finish/);
    },
);
const offer = await na.startExchange(null, channel, alice, bob);
await check("Only opted-in chats respond; generated setup bypasses AES without leaking drafts", async () => {
    assert.equal(
        (await nb.handleExchange(null, channel, bob, alice, alice, offer.outgoing)).outgoing,
        undefined,
    );
    assert.equal(na.prepareOutgoing(null, channel, alice, offer.outgoing).content, offer.outgoing);
    await nb.setMethod(null, channel, "automatic", bob, alice);
    await assert.rejects(na.setMethod(null, channel, "automatic", bob, alice), /different account/);
});
const reply = await nb.handleExchange(null, channel, bob, alice, alice, offer.outgoing);
const ack = await na.handleExchange(null, channel, alice, bob, bob, reply.outgoing);
const finish = await nb.handleExchange(null, channel, bob, alice, alice, ack.outgoing);
await na.handleExchange(null, channel, alice, bob, bob, finish.outgoing);
await check("Loading completed setup history does not transmit another confirmation", async () => {
    const replay = await nb.handleExchange(null, channel, bob, alice, alice, ack.outgoing, true);
    assert.equal(replay.outgoing, undefined);
    assert.equal(
        (await nb.handleExchange(null, channel, bob, alice, alice, ack.outgoing)).outgoing,
        finish.outgoing,
    );
});
await check(
    "Native exchange persists the same key, returns no secrets in rendering state, and survives restart",
    async () => {
        assert.equal(na.revealKey(null, channel), nb.revealKey(null, channel));
        const snapshot = JSON.stringify([na.channelInfo(null, channel), na.channelStates(null)]);
        assert.equal(snapshot.includes(na.revealKey(null, channel)), false);
        assert.equal(snapshot.includes("privateIdentity"), false);
        const restarted = await import(pathToFileURL(ca.outfile).href + "?restart");
        assert.equal(restarted.revealKey(null, channel), na.revealKey(null, channel));
    },
);
const automatic = na.revealKey(null, channel);
const oldWire = na.prepareOutgoing(null, channel, alice, "automatic history").content;
await check(
    "Historical decryption keys can be selected for offline files without changing the active key",
    () => {
        assert.ok(na.channelInfo(null, channel).keyIds.includes(crypto.keyId(manual)));
        assert.equal(na.revealKey(null, channel, crypto.keyId(manual)), manual);
        assert.equal(na.revealKey(null, channel), automatic);
        assert.throws(() => na.revealKey(null, channel, "invalid"));
    },
);
await check("Verification is bound to the displayed identity code", () => {
    assert.throws(() => na.verifyIdentity(null, channel, "wrong"));
    const code = na.channelInfo(null, channel).identityFingerprint;
    assert.equal(code, nb.channelInfo(null, channel).identityFingerprint);
    assert.equal(na.verifyIdentity(null, channel, code).identityVerified, true);
});
await check(
    "Shared key, automatic and password selections retain their own keys and old history",
    async () => {
        await na.setMethod(null, channel, "shared");
        assert.equal(na.revealKey(null, channel), manual);
        await na.setMethod(null, channel, "password");
        await na.savePassword(null, channel, passphrase);
        assert.equal(na.revealKey(null, channel), passwordKey);
        assert.equal(na.decryptMessage(null, channel, alice, oldWire), "automatic history");
        await na.setMethod(null, channel, "automatic", alice, bob);
        assert.equal(na.revealKey(null, channel), automatic);
        await na.setMethod(null, channel, "password");
        assert.equal(na.revealKey(null, channel), passwordKey);
        const decryptedVault = keyModeElectron.safeStorage.decryptString(
            await readFile(path.join(ca.dir, "sharedkey-vault.bin")),
        );
        assert.equal(decryptedVault.includes(passphrase), false);
    },
);
await check(
    "Replacing a peer identity blocks new automatic sends while retaining old decryption keys",
    async () => {
        await na.setMethod(null, channel, "automatic", alice, bob);
        na.forgetPeerIdentity(null, channel);
        assert.throws(() => na.prepareOutgoing(null, channel, alice, "must not leak"));
        assert.equal(na.decryptMessage(null, channel, alice, oldWire), "automatic history");
        assert.equal(na.channelInfo(null, channel).identityVerified, false);
        assert.equal(na.channelInfo(null, channel).identityFingerprint, "");
    },
);
await check(
    "Identity changes block automatic text, files and old-code verification until approval",
    async () => {
        const offer = await na.startExchange(null, channel, alice, bob);
        const reply = await nb.handleExchange(null, channel, bob, alice, alice, offer.outgoing);
        const ack = await na.handleExchange(null, channel, alice, bob, bob, reply.outgoing);
        const finish = await nb.handleExchange(null, channel, bob, alice, alice, ack.outgoing);
        await na.handleExchange(null, channel, alice, bob, bob, finish.outgoing);
        const oldCode = na.channelInfo(null, channel).identityFingerprint;
        na.verifyIdentity(null, channel, oldCode);
        const changed = await kx.beginExchange(kx.createExchange(bob, alice), channel);
        await assert.rejects(
            na.handleExchange(null, channel, alice, bob, bob, changed.outgoing),
            /identity key changed/,
        );
        assert.equal(na.channelInfo(null, channel).identityChanged, true);
        assert.equal(na.channelInfo(null, channel).identityVerified, false);
        assert.throws(
            () => na.prepareOutgoing(null, channel, alice, "must not leak"),
            /identity key changed/,
        );
        assert.throws(
            () => na.encryptUpload(null, channel, new Uint8Array([1]), "file.txt"),
            /identity key changed/,
        );
        assert.throws(() => na.verifyIdentity(null, channel, oldCode));
        assert.equal(na.decryptMessage(null, channel, alice, oldWire), "automatic history");
        const restarted = await import(pathToFileURL(ca.outfile).href + "?changed");
        assert.equal(restarted.channelInfo(null, channel).identityChanged, true);
        na.forgetPeerIdentity(null, channel);
        assert.equal(na.channelInfo(null, channel).identityChanged, false);
    },
);
await check(
    "Changing settings during password derivation does not overwrite the newer selection",
    async () => {
        await na.setMethod(null, channel, "password");
        const deriving = na.savePassword(null, channel, "a new password");
        const rejection = assert.rejects(deriving, /changed while deriving/);
        await new Promise(setImmediate);
        na.setEnabled(null, channel, false);
        await rejection;
        assert.equal(na.channelInfo(null, channel).enabled, false);
        assert.equal(na.revealKey(null, channel), passwordKey);
    },
);
console.log(`${checks} key setup checks passed.`);
