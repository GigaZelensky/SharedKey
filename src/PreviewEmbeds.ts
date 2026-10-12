/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByCodeLazy } from "@webpack";

import { registerPreviewImage } from "./LocalImageActions";
import { discordImageUrl, gifUrl, previewLinks, refreshDiscordImage } from "./mediaLinks";
import type { SharedKeyNative } from "./Options";
import { previewsAllowed } from "./ReadingPolicy";

const refreshAttachmentUrl = findByCodeLazy(".toURLSafe(", "?await", "??") as (url: string) => Promise<string>;
const entries = new Map<string, { embed?: any; pending?: Promise<void>; expires: number; unregister?: () => void; }>();
const listeners = new Set<() => void>();
let generation = 0;
export function onPreviewReady(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; }
export function clearPreviewEmbeds() { generation++; entries.forEach(entry => entry.unregister?.()); entries.clear(); }
export function cachedPreviewEmbeds(text: string): any[] { return previewLinks(text).flatMap(link => entries.get(link.url)?.embed ?? []); }

export async function preparePreviewEmbeds(native: SharedKeyNative, text: string, message: any): Promise<void> {
    if (!previewsAllowed(message)) return;
    await Promise.all(previewLinks(text).map(async link => {
        if (!previewsAllowed(message)) return;
        const cached = entries.get(link.url);
        if (cached?.pending) return cached.pending;
        if (cached && cached.expires > Date.now()) return;
        const entry: { embed?: any; pending?: Promise<void>; expires: number; unregister?: () => void; } = cached ?? { expires: 0 };
        if (entries.size >= 256 && !entries.has(link.url)) {
            const oldest = entries.keys().next().value!;
            entries.get(oldest)?.unregister?.(); entries.delete(oldest);
        }
        entries.set(link.url, entry);
        const started = generation;
        entry.pending = (async () => {
            const resolved = link.page ? await native.resolveGifPreview(link.url)
                : { url: discordImageUrl(link.url) ? await refreshDiscordImage(link.url, refreshAttachmentUrl) : link.url, video: /\.mp4(?:\?|$)/i.test(link.url) };
            if (!resolved || !previewsAllowed(message)) return;
            let width: number; let height: number;
            if (resolved.video) {
                const video = document.createElement("video");
                try {
                    await new Promise<void>((resolve, reject) => {
                        video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("Cannot load video metadata."));
                        video.preload = "metadata"; video.src = resolved.url;
                    });
                    width = video.videoWidth; height = video.videoHeight;
                } finally { video.removeAttribute("src"); video.load(); }
            } else {
                const image = new Image(); image.src = resolved.url; await image.decode();
                width = image.naturalWidth; height = image.naturalHeight;
            }
            if (started !== generation || !width || !height) return;
            // Raw gateway/API fields. Discord's own converter assigns normalized
            // fields and determines whether this is an inline media preview.
            const media = { url: resolved.url, proxy_url: resolved.url, width, height, content_type: resolved.video ? "video/mp4" : gifUrl(resolved.url) ? "image/gif" : /\.webp(?:\?|$)/i.test(resolved.url) ? "image/webp" : "image/png" };
            entry.unregister?.();
            entry.unregister = resolved.video ? undefined : registerPreviewImage(resolved.url, media.content_type);
            entry.embed = { url: link.url, type: resolved.video ? "gifv" : "image", ...(resolved.video ? { video: media, thumbnail: { ...media, url: resolved.url, proxy_url: resolved.url } } : { thumbnail: media }) };
            entry.expires = Date.now() + 10 * 60 * 1000;
            listeners.forEach(callback => callback());
        })().catch(() => { entry.expires = Date.now() + 30000; }).finally(() => { entry.pending = undefined; });
        return entry.pending;
    }));
}
