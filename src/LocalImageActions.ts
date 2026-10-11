/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";

import { localImage } from "./FileAttachments";
import { SharedKeyNative } from "./Options";

const previews = new Map<string, { mime: string; refs: number }>();
function previewId(src: string) { try { const url = new URL(src); return url.origin + url.pathname; } catch { return src; } }
export function registerPreviewImage(src: string, mime: string) {
    const id = previewId(src);
    const entry = previews.get(id) ?? { mime, refs: 0 };
    entry.refs++;
    previews.set(id, entry);
    return () => { if (--entry.refs === 0 && previews.get(id) === entry) previews.delete(id); };
}
const urls = findByPropsLazy("isDiscordAssetUrl", "toURLSafe");
const actions = findByPropsLazy("canCopyImage", "copyImageBlob", "saveImage");

export function installLocalImageActions(native: SharedKeyNative) {
    const originalAsset = urls.isDiscordAssetUrl;
    const originalSave = actions.saveImage;
    const originalCopy = actions.copyImage;
    const asset = function (this: unknown, src: string, ...args: any[]) {
        return !!localImage(src) || previews.has(previewId(src)) || originalAsset.call(this, src, ...args);
    };
    const save = async function (this: unknown, src: string, ...args: any[]) {
        const file = localImage(src);
        if (!file) return originalSave.call(this, src, ...args);
        return await native.saveDecryptedAttachment(file.filename, new Uint8Array(await file.blob.arrayBuffer())) ? "saved" : "canceled";
    };
    const copy = function (this: unknown, src: string, mime?: string, ...args: any[]) {
        // Discord transcodes GIF/WebP as needed for the native clipboard.
        return originalCopy.call(this, src, localImage(src)?.mime ?? previews.get(previewId(src))?.mime ?? mime, ...args);
    };
    urls.isDiscordAssetUrl = asset;
    actions.saveImage = save;
    actions.copyImage = copy;
    return () => {
        previews.clear();
        if (urls.isDiscordAssetUrl === asset) urls.isDiscordAssetUrl = originalAsset;
        if (actions.saveImage === save) actions.saveImage = originalSave;
        if (actions.copyImage === copy) actions.copyImage = originalCopy;
    };
}
