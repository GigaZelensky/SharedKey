/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Decode an authenticated local file only. This never resolves a remote URL,
// plays audio, uploads a frame, or replaces Discord's video player.
export async function localVideoMetadata(url: string, timeout = 5000): Promise<{ width: number; height: number; duration?: number; poster: string; }> {
    if (!url.startsWith("blob:")) throw new Error("Video metadata requires a local blob.");
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    let frameCallback: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await new Promise((resolve, reject) => {
            let settled = false;
            const fail = () => { if (!settled) { settled = true; reject(new Error("This video cannot be previewed.")); } };
            timer = setTimeout(fail, timeout);
            video.onerror = fail;
            const capture = () => {
                if (settled || !video.videoWidth || !video.videoHeight) { fail(); return; }
                const width = video.videoWidth, height = video.videoHeight;
                const canvas = document.createElement("canvas");
                const scale = Math.min(1, 960 / width, 540 / height);
                canvas.width = Math.max(1, Math.round(width * scale));
                canvas.height = Math.max(1, Math.round(height * scale));
                try {
                    const context = canvas.getContext("2d");
                    if (!context) { fail(); return; }
                    context.drawImage(video, 0, 0, canvas.width, canvas.height);
                    canvas.toBlob(poster => {
                        if (settled) return;
                        if (!poster) { fail(); return; }
                        settled = true;
                        resolve({ width, height, duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined, poster: URL.createObjectURL(poster) });
                    }, "image/png");
                } catch { fail(); }
            };
            let waitingForFrame = false;
            video.onloadeddata = () => {
                if (settled || waitingForFrame) return;
                waitingForFrame = true;
                if (typeof video.requestVideoFrameCallback === "function") {
                    frameCallback = video.requestVideoFrameCallback(() => { video.pause(); capture(); });
                    void video.play().catch(fail);
                } else capture();
            };
            video.src = url;
            video.load();
        });
    } finally {
        clearTimeout(timer);
        if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
        video.pause();
        video.onloadeddata = null;
        video.onerror = null;
        video.onseeked = null;
        video.removeAttribute("src");
        video.load();
    }
}
