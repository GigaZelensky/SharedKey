/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface GifPreview { url: string; video: boolean; }
const cache = new Map<string, Promise<GifPreview | null>>();

export function gifPage(value: string): URL | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port) return;
        if (!/^(?:www\.)?(?:tenor|klipy)\.com$/.test(url.hostname)) return;
        if (!/^\/(?:view|gifs)\/[a-z0-9_-]+\/?$/i.test(url.pathname)) return;
        url.search = "";
        url.hash = "";
        return url;
    } catch { return; }
}

function media(value: string, provider: string): GifPreview | undefined {
    try {
        const url = new URL(value.replace(/&amp;|&#38;|&#x26;/gi, "&"));
        if (url.protocol !== "https:" || url.username || url.password || url.port) return;
        if (provider === "tenor" ? !/^(?:media\d*|c)\.tenor\.com$/.test(url.hostname) : !/^static\d*\.klipy\.com$/.test(url.hostname)) return;
        if (!/\.(?:gif|webp|png|jpe?g|mp4)$/i.test(url.pathname)) return;
        return { url: url.href, video: /\.mp4$/i.test(url.pathname) };
    } catch { return; }
}

export function gifMetadata(html: string, provider: string): GifPreview | null {
    const candidates: GifPreview[] = [];
    for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
        const attrs = new Map(Array.from(match[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g), m => [m[1].toLowerCase(), m[3]]));
        const name = attrs.get("property") ?? attrs.get("name") ?? "";
        if (!/^(?:og:image(?::url)?|twitter:image(?::src)?|og:video(?::url|:secure_url)?)$/i.test(name)) continue;
        const result = media(attrs.get("content") ?? "", provider);
        if (result) candidates.push(result);
    }
    return candidates.find(c => /\.gif(?:\?|$)/i.test(c.url)) ?? candidates.find(c => c.video) ?? candidates[0] ?? null;
}

export async function resolveGif(value: string): Promise<GifPreview | null> {
    const page = gifPage(value);
    if (!page) return null;
    let pending = cache.get(page.href);
    if (!pending) {
        pending = (async () => {
            const provider = page.hostname.includes("tenor") ? "tenor" : "klipy";
            let current = page;
            const signal = AbortSignal.timeout(15000);
            for (let i = 0; i < 4; i++) {
                const response = await fetch(current, { redirect: "manual", signal, credentials: "omit", headers: {
                    Accept: "text/html", "User-Agent": "SharedKey/1.0 (compatible with Discordbot/2.0)"
                } });
                if (response.status >= 300 && response.status < 400) {
                    await response.body?.cancel();
                    const next = gifPage(new URL(response.headers.get("location") ?? "", current).href);
                    if (!next || !next.hostname.includes(provider)) return null;
                    current = next;
                    continue;
                }
                if (!response.ok || !response.headers.get("content-type")?.includes("text/html") || !response.body) { await response.body?.cancel(); return null; }
                const reader = response.body.getReader();
                const chunks: Uint8Array[] = [];
                let size = 0;
                try {
                    for (;;) {
                        const { done, value: chunk } = await reader.read();
                        if (done) break;
                        if ((size += chunk.byteLength) > 512 * 1024) return null;
                        chunks.push(chunk);
                    }
                } finally { await reader.cancel(); }
                return gifMetadata(Buffer.concat(chunks).toString("utf8"), provider);
            }
            return null;
        })().catch(() => null);
        if (cache.size >= 200) cache.delete(cache.keys().next().value!);
        cache.set(page.href, pending);
        void pending.then(result => { if (!result && cache.get(page.href) === pending) cache.delete(page.href); });
    }
    return pending;
}
