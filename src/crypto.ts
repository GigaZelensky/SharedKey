/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

export const TEXT_PREFIX = "[VCS1:";
export const FILE_MAGIC = Buffer.from("VCSFILE1");
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 12000;
const KEY_PREFIX = "vcs1_";

export function generateKey(): string {
    return KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function parseKey(value: string): Buffer {
    if (!/^vcs1_[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Paste a generated vcs1_ shared key (not a password).");
    const bytes = Buffer.from(value.slice(KEY_PREFIX.length), "base64url");
    if (bytes.length !== 32 || KEY_PREFIX + bytes.toString("base64url") !== value) throw new Error("Invalid shared key.");
    return bytes;
}

export function keyId(key: string): string {
    return createHash("sha256").update(parseKey(key)).digest("hex").slice(0, 16);
}

export function checkId(id: string): void {
    if (!/^\d{5,22}$/.test(id)) throw new Error("Invalid Discord channel or user ID.");
}

function context(kind: "text" | "file", channelId: string, authorId = ""): Buffer {
    checkId(channelId);
    if (kind === "text") checkId(authorId);
    return Buffer.from(JSON.stringify(["VencordSharedKey", 1, kind, channelId, authorId]));
}

function seal(data: Buffer, key: string, aad: Buffer): Buffer {
    const id = Buffer.from(keyId(key), "hex");
    const nonce = randomBytes(12);
    const derived = hkdfSync("sha256", parseKey(key), id, aad, 32);
    const cipher = createCipheriv("aes-256-gcm", derived, nonce);
    cipher.setAAD(Buffer.concat([aad, id]));
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([id, nonce, ciphertext, cipher.getAuthTag()]);
}

function open(bundle: Buffer, keys: Record<string, string>, aad: Buffer): Buffer {
    if (bundle.length < 36) throw new Error("Truncated encrypted data.");
    const id = bundle.subarray(0, 8);
    const key = keys[id.toString("hex")];
    if (!key || keyId(key) !== id.toString("hex")) throw new Error("No matching key for this encrypted data.");
    const derived = hkdfSync("sha256", parseKey(key), id, aad, 32);
    const decipher = createDecipheriv("aes-256-gcm", derived, bundle.subarray(8, 20));
    decipher.setAAD(Buffer.concat([aad, id]));
    decipher.setAuthTag(bundle.subarray(-16));
    try {
        return Buffer.concat([decipher.update(bundle.subarray(20, -16)), decipher.final()]);
    } catch {
        throw new Error("Authentication failed: wrong key, changed data, or different chat/sender.");
    }
}

export function encryptText(text: string, key: string, channelId: string, authorId: string): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_TEXT_BYTES) throw new Error("Text is too long. Encrypt it as a file instead.");
    return TEXT_PREFIX + seal(bytes, key, context("text", channelId, authorId)).toString("base64url") + "]";
}

export function decryptText(text: string, keys: Record<string, string>, channelId: string, authorId: string): string {
    if (text.length > 17000 || !/^\[VCS1:[A-Za-z0-9_-]+\]$/.test(text)) throw new Error("Invalid encrypted message.");
    const encoded = text.slice(TEXT_PREFIX.length, -1);
    const bundle = Buffer.from(encoded, "base64url");
    if (bundle.toString("base64url") !== encoded) throw new Error("Invalid message encoding.");
    return new TextDecoder("utf-8", { fatal: true }).decode(open(bundle, keys, context("text", channelId, authorId)));
}

export function encryptFile(data: Buffer, filename: string, key: string, channelId: string): Buffer {
    if (data.length > MAX_FILE_BYTES) throw new Error("Files must be 64 MiB or smaller (and within your Discord upload limit).");
    const metadata = Buffer.from(JSON.stringify({ filename }));
    if (metadata.length > 4096) throw new Error("Filename is too long.");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(metadata.length);
    return Buffer.concat([FILE_MAGIC, seal(Buffer.concat([length, metadata, data]), key, context("file", channelId))]);
}

export function decryptFile(bundle: Buffer, keys: Record<string, string>, channelId: string): { filename: string; data: Buffer; } {
    if (bundle.length > MAX_FILE_BYTES + 4200 || !bundle.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) throw new Error("Not a Vencord SharedKey encrypted file.");
    const plaintext = open(bundle.subarray(FILE_MAGIC.length), keys, context("file", channelId));
    if (plaintext.length < 4) throw new Error("Invalid encrypted file metadata.");
    const length = plaintext.readUInt32BE(0);
    if (length > 4096 || length > plaintext.length - 4) throw new Error("Invalid encrypted file metadata.");
    const metadata = JSON.parse(plaintext.subarray(4, 4 + length).toString("utf8"));
    if (typeof metadata.filename !== "string" || !metadata.filename.length) throw new Error("Invalid encrypted filename.");
    // Filename is only a save-dialog suggestion, never an output path.
    const filename = metadata.filename.split(/[\\/]/).pop()!.replace(/[\x00-\x1f<>:"|?*]/g, "_");
    return { filename: filename || "decrypted-file", data: plaintext.subarray(4 + length) };
}
