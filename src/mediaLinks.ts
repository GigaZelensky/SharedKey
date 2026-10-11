/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface PreviewLink { page: boolean; url: string; }
export function discordEmojiUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.port && url.hostname === "cdn.discordapp.com" && /^\/emojis\/\d+\.(?:png|gif|webp|avif)$/i.test(url.pathname);
    } catch { return false; }
}

export function gifUrl(value: string): boolean {
    try { return /\.gif$/i.test(decodeURIComponent(new URL(value).pathname)); }
    catch { return false; }
}

export function discordImageUrl(value: string): URL | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port
            || !/^(?:cdn(?:-[a-z0-9-]+)?\.discordapp\.com|(?:media|images)(?:-[a-z0-9-]+)?\.discordapp\.net)$/.test(url.hostname)
            || !/^\/(?:attachments|ephemeral-attachments)\/\d+\/\d+\/[^/]+$/i.test(url.pathname)
            || !/\.(?:png|jpe?g|gif|webp|avif)$/i.test(decodeURIComponent(url.pathname.split("/").pop()!))) return;
        return url;
    } catch { return; }
}

export async function refreshDiscordImage(value: string, refresh: (url: string) => Promise<string>): Promise<string> {
    const original = discordImageUrl(value);
    if (!original) throw new Error("Unsupported Discord image URL.");
    // Use Discord's own signed-URL refresher. An expired URL cannot be decoded
    // by an Image preflight until the client's authenticated refresh completes.
    const result = await refresh(original.href);
    const updated = discordImageUrl(result);
    if (!updated || updated.pathname !== original.pathname) throw new Error("Image refresh returned a different attachment.");
    return updated.href;
}

export function previewLinks(text: string): PreviewLink[] {
    const visible = text.replace(/```[\s\S]*?```|`[^`\n]*`|<https?:\/\/[^>]+>|\|\|[\s\S]*?\|\|/g, "");
    const urls = new Map<string, PreviewLink>();
    for (const match of visible.matchAll(/https:\/\/[^\s<>]+/g)) {
        try {
            const url = new URL(match[0].replace(/[)\],.!?]+$/, ""));
            if (url.username || url.password || url.port) continue;
            const page = /^(?:www\.)?(?:tenor|klipy)\.com$/.test(url.hostname) && /^\/(?:view|gifs)\/[a-z0-9_-]+\/?$/i.test(url.pathname);
            const direct = /^(?:(?:media\d*|c)\.tenor\.com|static\d*\.klipy\.com)$/.test(url.hostname) && /\.(?:gif|webp|mp4)$/i.test(url.pathname);
            if (page || discordImageUrl(url.href) || discordEmojiUrl(url.href) || direct) urls.set(url.href, { page, url: url.href });
        } catch { /* Not a supported public media link. */ }
        if (urls.size === 4) break;
    }
    return Array.from(urls.values());
}
