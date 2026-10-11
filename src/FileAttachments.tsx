/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { TextButton } from "@components/Button";
import { Message, MessageAttachment } from "@vencord/discord-types";
import { showToast, useEffect, useRef, useState } from "@webpack/common";

import { NativeFile, NativeImage, NativeMediaPlayer } from "./NativeAttachments";
import { SharedKeyNative } from "./Options";

interface CachedFile { url: string; blob: Blob; filename: string; mime: string; width?: number; height?: number; refs: number; touched: number; }
const files = new Map<string, CachedFile>();
const imageUrls = new Map<string, CachedFile>();
export function localImage(url: string) { return imageUrls.get(url); }
const pendingFiles = new Map<string, Promise<CachedFile>>();
const fileListeners = new Set<() => void>();
const ordinaryFiles = new Set<string>();
let generation = 0;

export function onAttachmentReady(callback: () => void) { fileListeners.add(callback); return () => { fileListeners.delete(callback); }; }
export function cachedAttachmentInfo(channelId: string, id: string) { const file = files.get(`${channelId}:${id}`); return file ? { filename: file.filename, mime: file.mime, size: file.blob.size } : undefined; }

function trimFiles() {
    let total = Array.from(files.values()).reduce((sum, file) => sum + file.blob.size, 0);
    const unused = Array.from(files.entries()).filter(([, file]) => file.refs === 0).sort((a, b) => a[1].touched - b[1].touched);
    for (const [key, file] of unused) {
        if (files.size <= 32 && total <= 128 * 1024 * 1024) break;
        files.delete(key);
        imageUrls.delete(file.url);
        total -= file.blob.size;
        URL.revokeObjectURL(file.url);
    }
}

export function clearAttachmentCache() {
    generation++;
    files.forEach(file => URL.revokeObjectURL(file.url));
    files.clear();
    imageUrls.clear();
    ordinaryFiles.clear();
    pendingFiles.clear();
}

export function encryptedAttachments(message: Message): MessageAttachment[] {
    return (message.attachments ?? []).filter(file => /\.vcs$/i.test(file.filename) && !ordinaryFiles.has(`${message.channel_id}:${file.id}`));
}

function release(file: CachedFile) { file.refs = Math.max(0, file.refs - 1); file.touched = Date.now(); trimFiles(); }

async function acquire(native: SharedKeyNative, channelId: string, attachment: MessageAttachment, key: string): Promise<CachedFile> {
    let file = files.get(key);
    if (!file) {
        let request = pendingFiles.get(key);
        if (!request) {
            const startedGeneration = generation;
            request = native.decryptAttachment(channelId, attachment.url).then(async result => {
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

async function saveFile(native: SharedKeyNative, file: CachedFile) {
    try { await native.saveDecryptedAttachment(file.filename, new Uint8Array(await file.blob.arrayBuffer())); }
    catch { showToast("Could not save this file."); }
}

function Attachment({ attachment, channelId, native, version }: { attachment: MessageAttachment; channelId: string; native: SharedKeyNative; version: number; }) {
    const key = `${channelId}:${attachment.id}`;
    const [file, setFile] = useState<CachedFile>(() => files.get(key)!);
    const [showLoading, setShowLoading] = useState(false);
    const [diskOnly, setDiskOnly] = useState(attachment.size > 64 * 1024 * 1024 + 4200);
    const [downloadBusy, setDownloadBusy] = useState(false);
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    const [revealed, setRevealed] = useState(!attachment.spoiler && !attachment.filename.startsWith("SPOILER_"));
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => { if (error) setRetry(v => v + 1); }, [version]);
    useEffect(() => {
        let live = true;
        let held: CachedFile | undefined;
        let started = false;
        setError("");
        if (diskOnly) return;
        const load = () => {
            if (started) return;
            started = true;
            const loadingTimer = setTimeout(() => { if (live) setShowLoading(true); }, 300);
            void acquire(native, channelId, attachment, key).then(value => {
                clearTimeout(loadingTimer);
                if (!live) { release(value); return; }
                held = value;
                setFile(value);
            }).catch(e => {
                clearTimeout(loadingTimer);
                if (live) {
                    const reason = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "Could not load attachment.";
                    if (reason === "SHAREDKEY_ORDINARY_ATTACHMENT") return;
                    if (reason.includes("64 MiB")) setDiskOnly(true);
                    else setError(reason);
                }
            });
        };
        // Load near the viewport so scrolling old history does not download every file.
        const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); } }, { rootMargin: "600px" });
        if (ref.current) observer.observe(ref.current);
        else load();
        return () => { live = false; observer.disconnect(); if (held) release(held); };
    }, [key, attachment.url, retry, diskOnly]);

    async function downloadEncrypted() {
        setDownloadBusy(true);
        setError("");
        try { if (await native.downloadEncryptedAttachment(channelId, attachment.url, attachment.filename)) showToast("Encrypted file saved."); }
        catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "Download failed."); }
        finally { setDownloadBusy(false); }
    }

    return <div ref={ref} className="vc-sharedkey-decrypted-file">
        {!file && diskOnly ? <>
            <NativeFile url={attachment.url} fileName={attachment.filename} fileSize={attachment.size}
                onClick={(event: MouseEvent) => { event.preventDefault(); if (!downloadBusy) void downloadEncrypted(); }} />
            {downloadBusy && <span className="vc-sharedkey-file-loading">Downloading…</span>}
            {error && <span className="vc-sharedkey-file-error">{error}</span>}
        </> : !file ? error
            ? <div className="vc-sharedkey-file-error"><span>{error}</span><TextButton onClick={() => setRetry(v => v + 1)}>Retry</TextButton></div>
            : <span className="vc-sharedkey-file-loading" role="status">{showLoading ? "Loading attachment…" : ""}</span>
            : !revealed ? <button className="vc-sharedkey-spoiler" onClick={() => setRevealed(true)}>Show attachment</button>
                : file.mime.startsWith("image/") && file.width && file.height ? <NativeImage
                    src={file.url} original={file.url} alt={file.filename} width={file.width} height={file.height}
                    maxWidth={400} maxHeight={300} useFullWidth={false} shouldLink={false}
                    autoPlay={file.mime === "image/gif"} animated={file.mime === "image/gif"} srcIsAnimated={file.mime === "image/gif"}
                    contentType={file.mime} originalContentType={file.mime} disableAltTextDisplay
                /> : file.mime.startsWith("video/") || file.mime.startsWith("audio/") ? <NativeMediaPlayer
                    src={file.url} type={file.mime.startsWith("video/") ? "VIDEO" : "AUDIO"}
                    fileName={file.filename} fileSizeBytes={file.blob.size} mimeType={file.mime} playable
                    width={400} height={225} responsive
                /> : <NativeFile url={file.url} fileName={file.filename} fileSize={file.blob.size}
                    onClick={(event: MouseEvent) => { event.preventDefault(); void saveFile(native, file); }} />}
    </div>;
}

export function EncryptedFiles({ message, native, version }: { message: Message; native: SharedKeyNative; version: number; }) {
    const attachments = encryptedAttachments(message);
    if (!attachments.length) return null;
    return <div className="vc-sharedkey-file-list">{attachments.map(file => <Attachment key={file.id} attachment={file} channelId={message.channel_id} native={native} version={version} />)}</div>;
}

export function hideEncryptedOriginals(row: HTMLElement, message: Message): () => void {
    const hidden = new Map<HTMLElement, { value: string; priority: string; path: string; }>();
    const captions = new Map<HTMLElement, { value: string; priority: string; }>();
    const hide = () => {
        if (message.content?.startsWith("[VCS1:")) for (const caption of row.querySelectorAll<HTMLElement>('[id^="message-content-"], [class*="markup_"]')) {
            if (caption.closest(".vc-sharedkey-message, .vc-sharedkey-attachments-only")) continue;
            // Some compact confirmation previews omit the message-content id.
            if (!caption.id.startsWith("message-content-") && !caption.textContent?.startsWith("[VCS1:")) continue;
            if (!captions.has(caption)) captions.set(caption, { value: caption.style.getPropertyValue("display"), priority: caption.style.getPropertyPriority("display") });
            caption.style.setProperty("display", "none", "important");
        }
        const paths = new Set(encryptedAttachments(message).map(file => { try { return new URL(file.url).pathname; } catch { return ""; } }));
        for (const [card, original] of hidden) if (!paths.has(original.path)) {
            if (original.value) card.style.setProperty("display", original.value, original.priority); else card.style.removeProperty("display");
            hidden.delete(card);
        }
        for (const link of row.querySelectorAll<HTMLAnchorElement>("a[href]")) {
            if (link.closest(".vc-sharedkey-message, .vc-sharedkey-attachments-only")) continue;
            try { if (!paths.has(new URL(link.href).pathname)) continue; } catch { continue; }
            const card = (link.closest('[class*="fileWrapper"]') ?? link.closest('[class*="attachment_"]') ?? link.closest('[class*="file_"]') ?? link.parentElement) as HTMLElement;
            if (hidden.has(card)) continue;
            hidden.set(card, { value: card.style.getPropertyValue("display"), priority: card.style.getPropertyPriority("display"), path: new URL(link.href).pathname });
            card.style.setProperty("display", "none", "important");
        }
    };
    hide();
    const observer = new MutationObserver(hide);
    const unsubscribe = onAttachmentReady(hide);
    observer.observe(row, { childList: true, subtree: true });
    return () => {
        observer.disconnect();
        unsubscribe();
        hidden.forEach((original, card) => { if (original.value) card.style.setProperty("display", original.value, original.priority); else card.style.removeProperty("display"); });
        captions.forEach((original, caption) => { if (original.value) caption.style.setProperty("display", original.value, original.priority); else caption.style.removeProperty("display"); });
    };
}
