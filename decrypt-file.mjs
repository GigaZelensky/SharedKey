/* SharedKey offline file decryptor — GPL-3.0-or-later */
import { createDecipheriv, createHash, hkdfSync, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, open, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const usage =
    "Usage: node decrypt-file.mjs --file encrypted.vcs --channel CHAT_ID --output original-file [--key-file key.txt]";
if (process.argv.includes("--help")) {
    console.log(usage);
    process.exit(0);
}
const options = {};
const allowed = new Set(["--file", "--channel", "--output", "--key-file"]);
for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i],
        value = process.argv[i + 1];
    if (!allowed.has(name) || !value || value.startsWith("--") || Object.hasOwn(options, name)) {
        console.error(usage);
        process.exit(1);
    }
    options[name] = value;
}
if (!options["--file"] || !options["--channel"] || !options["--output"]) {
    console.error(usage);
    process.exit(1);
}
const channel = options["--channel"];
if (!/^\d{5,22}$/.test(channel))
    throw new Error("Invalid chat ID. Find it in the chat encryption options under Setup and decryption.");
const input = resolve(options["--file"]);
const output = resolve(options["--output"]);
const temporary = output + ".unverified-" + randomUUID();
async function readKey() {
    if (options["--key-file"]) {
        if ((await stat(options["--key-file"])).size > 256) throw new Error("Key file is too large.");
        return (await readFile(options["--key-file"], "utf8")).trim();
    }
    const muted = new Writable({
        write(_chunk, _encoding, done) {
            done();
        },
    });
    const rl = createInterface({ input: process.stdin, output: muted, terminal: !!process.stdin.isTTY });
    if (process.stdin.isTTY) process.stdout.write("Shared key (hidden): ");
    try {
        return (await rl.question("")).trim();
    } finally {
        rl.close();
        if (process.stdin.isTTY) process.stdout.write("\n");
    }
}
async function main() {
    try {
        await stat(output);
        throw new Error("Output already exists. Choose a new filename.");
    } catch (e) {
        if (e.code !== "ENOENT") throw e;
    }
    const key = await readKey();
    if (!/^vcs1_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("Use the vcs1_ shared key from the plugin.");
    const raw = Buffer.from(key.slice(5), "base64url");
    if (raw.length !== 32 || "vcs1_" + raw.toString("base64url") !== key)
        throw new Error("Invalid shared key.");
    const size = (await stat(input)).size;
    if (!Number.isSafeInteger(size) || size < 48) throw new Error("Truncated encrypted file.");
    const handle = await open(input, "r");
    const header = Buffer.alloc(28),
        tag = Buffer.alloc(16);
    try {
        if (
            (await handle.read(header, 0, 28, 0)).bytesRead !== 28 ||
            (await handle.read(tag, 0, 16, size - 16)).bytesRead !== 16
        )
            throw new Error("Truncated encrypted file.");
    } finally {
        await handle.close();
    }
    if (header.subarray(0, 8).toString() !== "VCSFILE1") throw new Error("Not a SharedKey .vcs file.");
    const id = header.subarray(8, 16);
    if (!createHash("sha256").update(raw).digest().subarray(0, 8).equals(id))
        throw new Error(
            `This file needs key ${id.toString("hex")}. Select that fingerprint under Setup and decryption.`,
        );
    const aad = Buffer.from(JSON.stringify(["VencordSharedKey", 1, "file", channel, ""]));
    const cipher = createDecipheriv(
        "aes-256-gcm",
        hkdfSync("sha256", raw, id, aad, 32),
        header.subarray(16, 28),
    );
    cipher.setAAD(Buffer.concat([aad, id]));
    cipher.setAuthTag(tag);
    let prefix = Buffer.alloc(0),
        metadataLength,
        metadata,
        ready = false;
    const stripMetadata = new Transform({
        transform(chunk, _encoding, done) {
            try {
                if (ready) {
                    done(null, chunk);
                    return;
                }
                prefix = Buffer.concat([prefix, chunk]);
                if (metadataLength === undefined && prefix.length >= 4) {
                    metadataLength = prefix.readUInt32BE();
                    if (metadataLength > 4096) throw new Error("Invalid file metadata.");
                }
                if (metadataLength !== undefined && prefix.length >= 4 + metadataLength) {
                    metadata = JSON.parse(prefix.subarray(4, 4 + metadataLength).toString("utf8"));
                    if (typeof metadata.filename !== "string" || !metadata.filename.length)
                        throw new Error("Invalid original filename.");
                    ready = true;
                    const data = prefix.subarray(4 + metadataLength);
                    prefix = Buffer.alloc(0);
                    done(null, data);
                } else done();
            } catch (e) {
                done(e);
            }
        },
    });
    await pipeline(
        createReadStream(input, { start: 28, end: size - 17 }),
        cipher,
        stripMetadata,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    if (!ready) throw new Error("Truncated file metadata.");
    // The final output is published only after AES-GCM authentication succeeds.
    // Both paths share a directory. Linking is an exclusive, atomic publish: a
    // destination created while decryption runs is never overwritten.
    await link(temporary, output);
    await rm(temporary);
    console.log("Decrypted and authenticated: " + output);
    console.log(
        "Original filename: " +
            metadata.filename
                .split(/[\\/]/)
                .pop()
                .replace(/[\x00-\x1f]/g, "_"),
    );
}
try {
    await main();
} catch (e) {
    await rm(temporary, { force: true });
    console.error("Decryption failed: " + e.message);
    process.exitCode = 1;
}
