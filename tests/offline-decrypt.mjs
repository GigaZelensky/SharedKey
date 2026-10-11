import assert from "node:assert/strict";
import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, watch, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = root + "/.test-output/offline-test-" + Date.now();
await mkdir(dir, { recursive: true });
const require = createRequire(root + "/package.json");
await require("esbuild").build({
    entryPoints: [root + "/src/attachmentTransport.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: dir + "/transport.mjs",
});
const { streamEncryptedToDisk } = await import(pathToFileURL(dir + "/transport.mjs"));
const raw = randomBytes(32),
    key = "vcs1_" + raw.toString("base64url"),
    channel = "123456789012345678";
const id = createHash("sha256").update(raw).digest().subarray(0, 8),
    nonce = randomBytes(12);
const aad = Buffer.from(JSON.stringify(["VencordSharedKey", 1, "file", channel, ""]));
const metadata = Buffer.from(JSON.stringify({ filename: "large-original.bin" }));
const length = Buffer.alloc(4);
length.writeUInt32BE(metadata.length);
const cipher = createCipheriv("aes-256-gcm", hkdfSync("sha256", raw, id, aad, 32), nonce);
cipher.setAAD(Buffer.concat([aad, id]));
const expected = createHash("sha256");
const block = Buffer.alloc(65536, 90);
const count = 1025;
async function* encrypted() {
    yield Buffer.concat([Buffer.from("VCSFILE1"), id, nonce]);
    yield cipher.update(Buffer.concat([length, metadata]));
    for (let i = 0; i < count; i++) {
        expected.update(block);
        yield cipher.update(block);
    }
    yield cipher.final();
    yield cipher.getAuthTag();
}
await pipeline(Readable.from(encrypted()), createWriteStream(dir + "/large.vcs"));
await writeFile(dir + "/key.txt", key, { mode: 0o600 });
const url = `https://cdn.discordapp.com/attachments/${channel}/456789012345678901/encrypted.vcs`;
await streamEncryptedToDisk(
    channel,
    url,
    dir + "/downloaded.vcs",
    async () => new Response(Readable.toWeb(createReadStream(dir + "/large.vcs"))),
);
assert.equal((await stat(dir + "/downloaded.vcs")).size, (await stat(dir + "/large.vcs")).size);
execFileSync(
    process.execPath,
    [
        root + "/decrypt-file.mjs",
        "--file",
        dir + "/downloaded.vcs",
        "--channel",
        channel,
        "--output",
        dir + "/original.bin",
        "--key-file",
        dir + "/key.txt",
    ],
    { stdio: "pipe" },
);
assert.equal((await stat(dir + "/original.bin")).size, count * block.length);
const actual = createHash("sha256");
for await (const data of createReadStream(dir + "/original.bin")) actual.update(data);
assert.equal(actual.digest("hex"), expected.digest("hex"));
console.log("PASS >64 MiB ciphertext streams to disk and decrypts offline byte-for-byte");
await require("esbuild").build({
    entryPoints: [root + "/src/crypto.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: dir + "/crypto.mjs",
});
const sample = await import(pathToFileURL(dir + "/crypto.mjs"));
const small = sample.encryptFile(Buffer.from("authenticated payload"), "payload.txt", key, channel);
small[small.length - 1] ^= 1;
await writeFile(dir + "/tampered.vcs", small);
assert.throws(() =>
    execFileSync(
        process.execPath,
        [
            root + "/decrypt-file.mjs",
            "--file",
            dir + "/tampered.vcs",
            "--channel",
            channel,
            "--output",
            dir + "/must-not-exist.bin",
            "--key-file",
            dir + "/key.txt",
        ],
        { stdio: "pipe" },
    ),
);
await assert.rejects(() => stat(dir + "/must-not-exist.bin"));
assert.equal(
    (await readdir(dir)).some((name) => name.includes("unverified-")),
    false,
);
console.log("PASS authentication failure exposes no final plaintext and removes temporary output");
await assert.rejects(() =>
    streamEncryptedToDisk(
        channel,
        url,
        dir + "/interrupted.vcs",
        async () =>
            new Response(
                new ReadableStream({
                    start(c) {
                        c.enqueue(new Uint8Array([1, 2, 3]));
                        c.error(new Error("Interrupted"));
                    },
                }),
            ),
    ),
);
await assert.rejects(() => stat(dir + "/interrupted.vcs"));
assert.equal(
    (await readdir(dir)).some((name) => name.endsWith(".part")),
    false,
);
console.log("PASS failed encrypted download removes partial output");

// Reserve the destination after the CLI's initial existence check but before
// authenticated publication. The other writer's data must survive the race.
const racingOutput = dir + "/racing-output.bin";
let reserved = false;
const watcher = watch(dir, (_event, name) => {
    if (String(name).startsWith("racing-output.bin.unverified-") && !reserved) {
        reserved = true;
        writeFileSync(racingOutput, "another writer's file", { flag: "wx" });
    }
});
try {
    const child = spawn(
        process.execPath,
        [
            root + "/decrypt-file.mjs",
            "--file",
            dir + "/large.vcs",
            "--channel",
            channel,
            "--output",
            racingOutput,
            "--key-file",
            dir + "/key.txt",
        ],
        { stdio: "ignore" },
    );
    const status = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    assert.equal(reserved, true);
    assert.notEqual(status, 0);
    assert.equal(await readFile(racingOutput, "utf8"), "another writer's file");
    assert.equal(
        (await readdir(dir)).some((name) => name.includes("unverified-")),
        false,
    );
    console.log(
        "PASS destination created during decryption is preserved without leaving temporary plaintext",
    );
} finally {
    watcher.close();
}
