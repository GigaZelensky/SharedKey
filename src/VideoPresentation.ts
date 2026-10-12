/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { failVideoPreview, localFile, localVideoPoster } from "./FileAttachments";

export function nativeVideoProps(props: any) {
    const file = typeof props.src === "string" ? localFile(props.src) : undefined;
    if (!file?.mime.startsWith("video/") || !file.poster) return props;
    return { ...props, poster: file.poster, naturalWidth: file.width, naturalHeight: file.height, mimeType: file.mime.split("/") };
}

// Detect a failed native presentation without adding another media renderer.
// A hidden/offscreen row can legitimately have no loaded native media yet.
export function watchVideoPresentation(row: HTMLElement, urls: string[], delay = 8000) {
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const matches = (value: string, url: string) => value.split(/[?#]/)[0] === url.split(/[?#]/)[0];
    const check = () => {
        timer = undefined;
        if (!visible || !row.isConnected) return;
        for (const url of urls) {
            const file = localFile(url);
            if (!file?.width) continue;
            const poster = localVideoPoster(url);
            const shown = Array.from(row.querySelectorAll("video, img")).some(node => {
                if (node instanceof HTMLVideoElement) return !node.error && (matches(node.currentSrc || node.src, url) || (!!poster && matches(node.poster, poster)));
                return node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0 && !!poster && matches(node.currentSrc || node.src, poster);
            });
            if (!shown) failVideoPreview(url);
        }
    };
    const error = (event: Event) => {
        const { target } = event;
        const src = target instanceof HTMLMediaElement ? target.currentSrc || target.src : target instanceof HTMLImageElement ? target.currentSrc || target.src : "";
        if (src) failVideoPreview(src);
    };
    const observer = new IntersectionObserver(entries => {
        visible = entries.some(entry => entry.isIntersecting);
        clearTimeout(timer);
        if (visible) timer = setTimeout(check, delay);
    });
    observer.observe(row);
    row.addEventListener("error", error, true);
    return () => { observer.disconnect(); clearTimeout(timer); row.removeEventListener("error", error, true); };
}
