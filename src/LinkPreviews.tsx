/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByCodeLazy } from "@webpack";
import { Parser, useEffect, useState } from "@webpack/common";

import { EditedMarker } from "./EditedMarker";
import type { GifPreview } from "./gifResolver";
import { registerPreviewImage } from "./LocalImageActions";
import { discordImageUrl, gifUrl, previewLinks, refreshDiscordImage } from "./mediaLinks";
import { NativeImage } from "./NativeAttachments";
import { SharedKeyNative } from "./Options";

export { previewLinks } from "./mediaLinks";
const refreshAttachmentUrl = findByCodeLazy(".toURLSafe(", "?await", "??") as (url: string) => Promise<string>;

function Preview({ link, native, ready }: { link: { page: boolean; url: string; }; native: SharedKeyNative; ready(url: string): void; }) {
    const attachment = !!discordImageUrl(link.url);
    const [resolved, setResolved] = useState<GifPreview | null>(link.page || attachment ? null : { url: link.url, video: /\.mp4(?:\?|$)/i.test(link.url) });
    const [broken, setBroken] = useState(false);
    useEffect(() => {
        if (!link.page && !attachment) return;
        let live = true;
        const request = attachment ? refreshDiscordImage(link.url, refreshAttachmentUrl).then(url => ({ url, video: false })) : native.resolveGifPreview(link.url);
        void request.then(result => { if (live) setResolved(result); }).catch(() => { if (live) setBroken(true); });
        return () => { live = false; };
    }, [link.url, attachment]);
    const [dimensions, setDimensions] = useState<{ url: string; width: number; height: number; } | null>(null);
    useEffect(() => {
        if (!resolved || resolved.video) return;
        let live = true;
        let unregister: (() => void) | undefined;
        const image = new Image();
        image.src = resolved.url;
        void image.decode().then(() => {
            if (!live) return;
            unregister = registerPreviewImage(resolved.url, gifUrl(resolved.url) ? "image/gif" : "image/png");
            setDimensions({ url: resolved.url, width: image.naturalWidth, height: image.naturalHeight });
            ready(link.url);
        }).catch(() => { if (live) setBroken(true); });
        return () => { live = false; unregister?.(); };
    }, [resolved?.url]);
    if (!resolved || broken) return null;
    const gif = gifUrl(resolved.url);
    return <div className="vc-sharedkey-preview">
        {resolved.video ? <video src={resolved.url} autoPlay muted loop playsInline controls={false} onLoadedData={() => ready(link.url)} onError={() => setBroken(true)} />
            : dimensions?.url === resolved.url && <NativeImage src={resolved.url} original={resolved.url} alt={link.page ? "GIF" : "Image attachment"}
                width={dimensions.width} height={dimensions.height} maxWidth={400} maxHeight={300} useFullWidth={false} shouldLink={false}
                autoPlay={gif} animated={gif} srcIsAnimated={gif} contentType={gif ? "image/gif" : "image/png"} disableAltTextDisplay />}
    </div>;
}

export function PlaintextWithPreviews({ text, channelId, messageId, native, editedTimestamp }: { text: string; channelId: string; messageId: string; native: SharedKeyNative; editedTimestamp?: Date | null; }) {
    const links = previewLinks(text);
    const [loaded, setLoaded] = useState("");
    const single = links.length === 1 && text.trim() === links[0].url && loaded === links[0].url;
    return <>
        {!single && <div className="vc-sharedkey-plaintext">{Parser.parse(text, true, { channelId, messageId, allowLinks: true, allowHeading: true, allowList: true, allowEmojiLinks: true })}<EditedMarker timestamp={editedTimestamp} /></div>}
        {links.map(link => <Preview key={link.url} link={link} native={native} ready={setLoaded} />)}
        {single && <EditedMarker timestamp={editedTimestamp} />}
    </>;
}
