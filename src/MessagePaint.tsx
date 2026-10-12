/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { TextButton } from "@components/Button";
import type { Message } from "@vencord/discord-types";
import { useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";

import { attachmentError, attachmentView, encryptedAttachments, prepareAttachmentViews, retainAttachmentViews } from "./FileAttachments";
import { previewLinks } from "./mediaLinks";
import { highlightedTint, messageTint } from "./MessageColors";
import { joinMessageRun } from "./MessageRuns";
import { cachedPlaintext, decryptionFailed, requestPlaintext } from "./MessageView";
import type { SharedKeyNative } from "./Options";
import { cachedPreviewEmbeds, preparePreviewEmbeds } from "./PreviewEmbeds";
import { allowMessagePreview, ensureReadingPolicy, onReadingPolicyChange, previewMode, previewsAllowed, readingEnabled } from "./ReadingPolicy";
import { receiveCachedMessage } from "./ReceiveMessages";
import { watchVideoPresentation } from "./VideoPresentation";
import { wireMessage } from "./WireMessages";

export function MessagePaint({ message, native, version }: { message: Message; native: SharedKeyNative; version: number; }) {
    const wire = wireMessage(message);
    const [, renderPolicy] = useState(0);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [previewError, setPreviewError] = useState(false);
    const readable = readingEnabled(wire.channel_id);
    const protectedMessage = readable && (wire.content?.startsWith("[VCS1:") || !!encryptedAttachments(wire).length);
    const [color, setColor] = useState("#7d52ff");
    const ref = useRef<HTMLSpanElement>(null);
    const text = cachedPlaintext(wire) ?? (message !== wire ? message.content : undefined);
    const pendingFiles = encryptedAttachments(wire).filter(file => file.size <= 64 * 1024 * 1024 + 4200 && !attachmentView(wire.channel_id, file.id));
    useEffect(() => onReadingPolicyChange(() => renderPolicy(value => value + 1)), []);
    useEffect(() => { void ensureReadingPolicy(native, wire.channel_id)?.then(() => renderPolicy(value => value + 1)); }, [wire.channel_id]);
    useEffect(() => {
        if (!protectedMessage) return;
        let live = true;
        void native.channelInfo(wire.channel_id).then(info => { if (live) setColor(info.color); }).catch(() => {});
        return () => { live = false; };
    }, [wire.channel_id, version, readable]);
    useEffect(() => {
        if (!protectedMessage) return;
        receiveCachedMessage(message);
        const node = ref.current;
        let live = true;
        const load = () => {
            if (wire.content?.startsWith("[VCS1:")) void requestPlaintext(native, wire).then(value => { if (live) void preparePreviewEmbeds(native, value, wire); }).catch(() => {});
            else if (text) void preparePreviewEmbeds(native, text, wire);
            void prepareAttachmentViews(native, wire);
        };
        const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); } }, { rootMargin: "600px" });
        const row = node?.closest("li");
        if (row) observer.observe(row); else load();
        return () => { live = false; observer.disconnect(); };
    }, [wire, version, readable, previewsAllowed(wire)]);
    useLayoutEffect(() => {
        const row = ref.current?.closest("li") as HTMLElement | null;
        if (!row || !protectedMessage) return;
        row.classList.add("vc-sharedkey-row");
        row.classList.toggle("vc-sharedkey-decrypt-error", decryptionFailed(wire));
        row.dataset.sharedkeyChannel = wire.channel_id;
        row.style.setProperty("--vc-sharedkey-color", color);
        row.style.setProperty("--vc-sharedkey-fill", message.mentioned ? highlightedTint(color, 0.14) : messageTint(color, 0.14));
        row.style.setProperty("--vc-sharedkey-hover", message.mentioned ? highlightedTint(color, 0.105) : messageTint(color, 0.105));
        const cleanupRun = joinMessageRun(row);
        const release = retainAttachmentViews(wire.channel_id, wire.attachments ?? []);
        return () => {
            release(); cleanupRun(); row.classList.remove("vc-sharedkey-row", "vc-sharedkey-decrypt-error"); delete row.dataset.sharedkeyChannel;
            for (const property of ["--vc-sharedkey-color", "--vc-sharedkey-fill", "--vc-sharedkey-hover"]) row.style.removeProperty(property);
        };
    }, [message, color, protectedMessage]);
    useEffect(() => {
        const row = ref.current?.closest("li");
        if (!row || !protectedMessage) return;
        const videos = (wire.attachments ?? []).flatMap(file => {
            const view = attachmentView(wire.channel_id, file.id);
            return view?.mime.startsWith("video/") && view.width ? [view.url] : [];
        });
        if (videos.length) return watchVideoPresentation(row, videos);
    }, [message, protectedMessage]);
    if (!protectedMessage) return null;
    const previewButton = text && previewMode(wire.channel_id) === "manual" && previewLinks(text).length > 0 && (!previewsAllowed(wire) || !cachedPreviewEmbeds(text).length);
    return <span ref={ref} className="vc-sharedkey-paint">
        {previewButton && <TextButton disabled={loadingPreview} title="Contacts the preview host; Discord links may contact Discord." onClick={async () => {
            allowMessagePreview(wire); setLoadingPreview(true); setPreviewError(false);
            try { await preparePreviewEmbeds(native, text, wire); setPreviewError(!cachedPreviewEmbeds(text).length); }
            finally { setLoadingPreview(false); }
        }}>{loadingPreview ? "Loading preview…" : previewError ? "Retry preview" : "Load preview"}</TextButton>}
        {pendingFiles.filter(file => attachmentError(wire.channel_id, file.id)).map(file => <span key={file.id} className="vc-sharedkey-file-loading">
            {attachmentError(wire.channel_id, file.id)}
            {attachmentError(wire.channel_id, file.id) && <TextButton onClick={() => { void prepareAttachmentViews(native, wire, true); }}>Retry</TextButton>}
        </span>)}
    </span>;
}
