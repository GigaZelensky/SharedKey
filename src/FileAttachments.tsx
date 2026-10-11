/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message, MessageAttachment } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";

import type { SharedKeyNative } from "./Options";

interface CachedFile { url: string; blob: Blob; filename: string; mime: string; width?: number; height?: number; refs: number; touched: number; }
const files = new Map<string, CachedFile>();
const imageUrls = new Map<string, CachedFile>();
export function localImage(url: string) { return imageUrls.get(url.split("#")[0]); }
export function localFile(url: string) { return Array.from(files.values()).find(file => file.url === url.split("#")[0]); }
const pendingFiles = new Map<string, Promise<CachedFile>>();
const fileListeners = new Set<() => void>();
const ordinaryFiles = new Set<string>();
const loadErrors = new Map<string, string>();
const refreshAttachmentUrl = findByCodeLazy(".toURLSafe(", "?await", "??") as (url: string) => Promise<string>;
let generation = 0;

export function onAttachmentReady(callback: () => void) { fileListeners.add(callback); return () => { fileListeners.delete(callback); }; }
export function cachedAttachmentInfo(channelId: string, id: string) { const file = files.get(`${channelId}:${id}`); return file ? { filename: file.filename, mime: file.mime, size: file.blob.size } : undefined; }
export function attachmentView(channelId: string, id: string) { return files.get(`${channelId}:${id}`); }
export function attachmentError(channelId: string, id: string) { return loadErrors.get(`${channelId}:${id}`); }
export function retryFailedAttachments() { loadErrors.clear(); }
export function retainAttachmentViews(channelId: string, attachments: MessageAttachment[]) {
    const held = attachments.flatMap(attachment => files.get(`${channelId}:${attachment.id}`) ?? []);
    held.forEach(file => { file.refs++; });
    return () => held.forEach(release);
}
export async function prepareAttachmentViews(native: SharedKeyNative, message: Message, retry = false) {
    await Promise.all(encryptedAttachments(message).filter(file => file.size <= 64 * 1024 * 1024 + 4200).map(async attachment => {
        const key = `${message.channel_id}:${attachment.id}`;
        if (loadErrors.has(key) && !retry) return;
        loadErrors.delete(key);
        try {
            const file = await acquire(native, message.channel_id, attachment, key);
            requestAnimationFrame(() => requestAnimationFrame(() => release(file)));
        } catch (error) {
            if (String(error).includes("SHAREDKEY_ORDINARY_ATTACHMENT")) return;
            if (loadErrors.size >= 500) loadErrors.delete(loadErrors.keys().next().value!);
            loadErrors.set(key, "Unable to decrypt attachment. Check this chat's key.");
            fileListeners.forEach(callback => callback());
        }
    }));
}

function trimFiles() {
    let total = Array.from(files.values()).reduce((sum, file) => sum + file.blob.size, 0);
    const unused = Array.from(files.entries()).filter(([, file]) => file.refs === 0).sort((a, b) => a[1].touched - b[1].touched);
    for (const [key, file] of unused) {
        if (files.size <= 32 && total <= 128 * 1024 * 1024) break;
        files.delete(key);
        imageUrls.delete(file.url);
        total -= file.blob.size;
        URL.revokeObjectURL(file.url);
        queueMicrotask(() => fileListeners.forEach(callback => callback()));
    }
}

export function clearAttachmentCache() {
    generation++;
    files.forEach(file => URL.revokeObjectURL(file.url));
    files.clear();
    imageUrls.clear();
    ordinaryFiles.clear();
    pendingFiles.clear();
    loadErrors.clear();
}

export function encryptedAttachments(message: Message): MessageAttachment[] {
    return (message.attachments ?? []).filter(file => /\.vcs$/i.test(file.filename) && !ordinaryFiles.has(`${message.channel_id}:${file.id}`));
}

function release(file: CachedFile) { file.refs = Math.max(0, file.refs - 1); file.touched = Date.now(); queueMicrotask(trimFiles); }

async function acquire(native: SharedKeyNative, channelId: string, attachment: MessageAttachment, key: string): Promise<CachedFile> {
    let file = files.get(key);
    if (!file) {
        let request = pendingFiles.get(key);
        if (!request) {
            const startedGeneration = generation;
            request = Promise.resolve().then(async () => {
                let { url } = attachment;
                try {
                    const original = new URL(url);
                    if (original.protocol === "https:" && !original.username && !original.password && !original.port && /^(?:cdn\.discordapp\.com|media\.discordapp\.net)$/.test(original.hostname)) {
                        const refreshed = new URL(await refreshAttachmentUrl(url));
                        if (refreshed.protocol === "https:" && !refreshed.username && !refreshed.password && !refreshed.port && /^(?:cdn\.discordapp\.com|media\.discordapp\.net)$/.test(refreshed.hostname) && refreshed.pathname === original.pathname) url = refreshed.href;
                    }
                } catch { /* Native download reports an unavailable attachment. */ }
                return native.decryptAttachment(channelId, url);
            }).then(async result => {
                if (generation !== startedGeneration) throw new Error("Attachment view closed.");
                if (result.encrypted === false) {
                    ordinaryFiles.add(key);
                    queueMicrotask(() => fileListeners.forEach(callback => callback()));
                    throw new Error("SHAREDKEY_ORDINARY_ATTACHMENT");
                }
                const blob = new Blob([new Uint8Array(result.data).buffer], { type: result.mime });
                const loaded = { url: URL.createObjectURL(blob), blob, filename: result.filename, mime: result.mime, refs: 0, touched: Date.now() };
                if (result.mime.startsWith("image/")) {
                    const image = new Image();
                    image.src = loaded.url;
                    try {
                        await image.decode();
                        Object.assign(loaded, { width: image.naturalWidth, height: image.naturalHeight });
                    } catch { /* An unsupported image falls back to Discord's file card. */ }
                }
                if (generation !== startedGeneration) { URL.revokeObjectURL(loaded.url); throw new Error("Attachment view closed."); }
                files.set(key, loaded);
                if (result.mime.startsWith("image/")) imageUrls.set(loaded.url, loaded);
                queueMicrotask(() => fileListeners.forEach(callback => callback()));
                return loaded;
            });
            pendingFiles.set(key, request);
            const complete = () => { if (pendingFiles.get(key) === request) pendingFiles.delete(key); };
            void request.then(complete, complete);
        }
        file = await request;
    }
    file.refs++;
    file.touched = Date.now();
    trimFiles();
    return file;
}
