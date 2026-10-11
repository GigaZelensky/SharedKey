/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Parser, useEffect, useState } from "@webpack/common";

import type { GifPreview } from "./gifResolver";
import { registerPreviewImage } from "./LocalImageActions";
import { NativeImage } from "./NativeAttachments";
import { SharedKeyNative } from "./Options";

export function previewLinks(text: string): { page: boolean; url: string; }[] {
    const visible = text.replace(/```[\s\S]*?```|`[^`\n]*`|<https?:\/\/[^>]+>|\|\|[\s\S]*?\|\|/g, "");
    const urls = new Map<string, { page: boolean; url: string; }>();
    for (const match of visible.matchAll(/https:\/\/[^\s<>]+/g)) {
        try {
            const url = new URL(match[0].replace(/[)\],.!?]+$/, ""));
            if (url.username || url.password || url.port) continue;
            const page = /^(?:www\.)?(?:tenor|klipy)\.com$/.test(url.hostname) && /^\/(?:view|gifs)\/[a-z0-9_-]+\/?$/i.test(url.pathname);
            const attachment = /^(?:cdn\.discordapp\.com|media\.discordapp\.net)$/.test(url.hostname) && /^\/attachments\/\d+\/\d+\/[^/]+\.(?:png|jpe?g|gif|webp|avif)$/i.test(url.pathname);
            const direct = /^(?:(?:media\d*|c)\.tenor\.com|static\d*\.klipy\.com)$/.test(url.hostname) && /\.(?:gif|webp|mp4)$/i.test(url.pathname);
            if (page || attachment || direct) urls.set(url.href, { page, url: url.href });
        } catch { /* Not a supported public media link. */ }
        if (urls.size === 4) break;
    }
    return Array.from(urls.values());
}

function Preview({ link, native, ready }: { link: { page: boolean; url: string; }; native: SharedKeyNative; ready(url: string): void; }) {
    const [resolved, setResolved] = useState<GifPreview | null>(link.page ? null : { url: link.url, video: /\.mp4(?:\?|$)/i.test(link.url) });
    const [broken, setBroken] = useState(false);
    useEffect(() => {
        if (!link.page) return;
        let live = true;
        void native.resolveGifPreview(link.url).then(result => { if (live) setResolved(result); }).catch(() => {});
        return () => { live = false; };
    }, [link.url]);
    const [dimensions, setDimensions] = useState<{ url: string; width: number; height: number; } | null>(null);
    useEffect(() => {
        if (!resolved || resolved.video) return;
        let live = true;
        let unregister: (() => void) | undefined;
        const image = new Image();
        image.src = resolved.url;
        void image.decode().then(() => {
            if (!live) return;
            unregister = registerPreviewImage(resolved.url, /\.gif(?:\?|$)/i.test(resolved.url) ? "image/gif" : "image/png");
            setDimensions({ url: resolved.url, width: image.naturalWidth, height: image.naturalHeight });
            ready(link.url);
        }).catch(() => { if (live) setBroken(true); });
        return () => { live = false; unregister?.(); };
    }, [resolved?.url]);
    if (!resolved || broken) return null;
    const gif = /\.gif(?:\?|$)/i.test(resolved.url);
    return <div className="vc-sharedkey-preview">
        {resolved.video ? <video src={resolved.url} autoPlay muted loop playsInline controls={false} onLoadedData={() => ready(link.url)} onError={() => setBroken(true)} />
            : dimensions?.url === resolved.url && <NativeImage src={resolved.url} original={resolved.url} alt={link.page ? "GIF" : "Image attachment"}
                width={dimensions.width} height={dimensions.height} maxWidth={400} maxHeight={300} useFullWidth={false} shouldLink={false}
                autoPlay={gif} animated={gif} srcIsAnimated={gif} contentType={gif ? "image/gif" : "image/png"} disableAltTextDisplay />}
    </div>;
}

export function PlaintextWithPreviews({ text, channelId, messageId, native }: { text: string; channelId: string; messageId: string; native: SharedKeyNative; }) {
    const links = previewLinks(text);
    const [loaded, setLoaded] = useState("");
    const single = links.length === 1 && text.trim() === links[0].url && loaded === links[0].url;
    return <>
        {!single && <div className="vc-sharedkey-plaintext">{Parser.parse(text, true, { channelId, messageId, allowLinks: true, allowHeading: true, allowList: true, allowEmojiLinks: true })}</div>}
        {links.map(link => <Preview key={link.url} link={link} native={native} ready={setLoaded} />)}
    </>;
}
