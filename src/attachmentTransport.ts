/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { checkId, MAX_FILE_BYTES } from "./crypto";

const MAX_ENCRYPTED_BYTES = MAX_FILE_BYTES + 4200;
let active = 0;
const waiting: (() => void)[] = [];

export function attachmentUrl(channelId: string, value: string): string {
    checkId(channelId);
    if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid attachment URL.");
    const url = new URL(value);
    const match = /^\/attachments\/(\d+)\/\d+\/[^/]+$/.exec(url.pathname);
    if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
        || url.username || url.password || url.port || !match || match[1] !== channelId) {
        throw new Error("Only Discord attachments from this chat can be decrypted.");
    }
    return url.href;
}

export async function downloadEncrypted(channelId: string, value: string, fetcher: typeof fetch = fetch): Promise<Buffer> {
    const url = attachmentUrl(channelId, value);
    if (active >= 3) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try {
        const res = await fetcher(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30000) });
        if (!res.ok || !res.body) throw new Error(`Attachment unavailable (${res.status}). Reopen the chat to refresh its download link.`);
        const length = Number(res.headers.get("content-length"));
        if (length > MAX_ENCRYPTED_BYTES) { await res.body.cancel(); throw new Error("Encrypted attachment exceeds the 64 MiB limit."); }
        const reader = res.body.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        try {
            while (true) {
                const { done, value: chunk } = await reader.read();
                if (done) break;
                total += chunk.byteLength;
                if (total > MAX_ENCRYPTED_BYTES) {
                    await reader.cancel();
                    throw new Error("Encrypted attachment exceeds the 64 MiB limit.");
                }
                chunks.push(Buffer.from(chunk));
            }
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks, total);
    } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
    }
}

export async function streamEncryptedToDisk(channelId: string, value: string, destination: string, fetcher: typeof fetch = fetch): Promise<void> {
    const url = attachmentUrl(channelId, value);
    const temporary = `${destination}.sharedkey-${randomUUID()}.part`;
    try {
        const res = await fetcher(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10 * 60 * 1000) });
        if (!res.ok || !res.body) throw new Error(`Attachment unavailable (${res.status}). Reopen the chat to refresh its download link.`);
        await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
        await rename(temporary, destination);
    } catch (e) {
        await rm(temporary, { force: true });
        throw e;
    }
}

export function mediaType(data: Buffer, filename: string): string {
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"))) return "image/gif";
    if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
    if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    if (data.subarray(4, 8).toString("ascii") === "ftyp") {
        const brand = data.subarray(8, 12).toString("ascii");
        if (["avif", "avis"].includes(brand)) return "image/avif";
        if (/\.(mp4|m4v)$/i.test(filename)) return "video/mp4";
    }
    if (/\.webm$/i.test(filename) && data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return "video/webm";
    if (/\.ogg$/i.test(filename) && data.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
    if (/\.mp3$/i.test(filename) && (data.subarray(0, 3).toString("ascii") === "ID3" || (data[0] === 255 && (data[1] & 224) === 224))) return "audio/mpeg";
    return "application/octet-stream";
}
