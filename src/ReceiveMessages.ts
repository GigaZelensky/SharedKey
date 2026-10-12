/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageStore, UserStore } from "@webpack/common";

import { EXCHANGE_PREFIX } from "./exchangeWire";
import { attachmentView, encryptedAttachments, onAttachmentReady } from "./FileAttachments";
import { mentionsUser } from "./localMentions";
import { cachedPlaintext, decryptionFailed, prepareHistory } from "./MessageView";
import type { SharedKeyNative } from "./Options";
import { cachedPreviewEmbeds, onPreviewReady } from "./PreviewEmbeds";
import { onReadingPolicyChange, previewsAllowed, readingEnabled } from "./ReadingPolicy";
import { allWireMessages, getWireMessage, markProtectedMessage, referenceAuthor, rememberIncoming, wireMessage } from "./WireMessages";

const presented = new Map<string, { wire: string; text: string; embeds: any[]; }>();

// Produces a raw incoming DTO, not a Discord record or a renderable object.
// Only Discord's ordinary dispatcher converts this into a Message instance.
export function receivedPayload(source: any, channelId: string): any {
    const wire = rememberIncoming(source, channelId);
    if (!readingEnabled(channelId)) return wire;
    const encrypted = wire.content?.startsWith("[VCS1:");
    const setup = wire.content?.startsWith(EXCHANGE_PREFIX);
    const files = encryptedAttachments(wire);
    const reference = wire.referenced_message;
    if (!encrypted && !setup && !files.length) return source;
    const id = `${channelId}:${wire.id}`;
    const previous = presented.get(id);
    const text = encrypted ? cachedPlaintext(wire) ?? (previous && previous.wire === wire.content ? previous.text : undefined) : wire.content;
    const previews = encrypted && text !== undefined ? cachedPreviewEmbeds(text) : [];
    const embeds = previewsAllowed(wire) ? (previews.length ? previews : previous && previous.wire === wire.content ? previous.embeds : []) : [];
    if (encrypted && text !== undefined) presented.set(id, { wire: wire.content, text, embeds });
    const content = setup ? "Encryption setup" : encrypted ? text ?? (decryptionFailed(wire) ? "Unable to decrypt. Check this chat's key." : "") : wire.content;
    const ids = new Set(files.map(file => file.id));
    const attachments = (wire.attachments ?? []).map((file: any) => {
        if (!ids.has(file.id)) return file;
        const local = attachmentView(channelId, file.id);
        if (!local) return file;
        markProtectedMessage(channelId, wire.id);
        const url = local.url + "#" + encodeURIComponent(local.filename);
        return { ...file, filename: local.filename, url, proxy_url: url, content_type: local.mime, size: local.blob.size, width: local.width, height: local.height };
    });
    const user = UserStore.getCurrentUser()?.id;
    const ref = wire.message_reference ?? wire.messageReference;
    const replyAuthor = reference?.author?.id ?? (ref?.message_id ? referenceAuthor(ref.channel_id ?? channelId, ref.message_id) : undefined);
    const mentions = [...(wire.mentions ?? [])];
    if (user && (mentionsUser(content, user) || replyAuthor === user) && !mentions.some((mention: any) => (mention.id ?? mention) === user)) mentions.push({ id: user });
    return { ...wire, content, attachments, mentions, embeds: encrypted && !previewsAllowed(wire) ? [] : [...(wire.embeds ?? []), ...embeds], ...(reference ? { referenced_message: reference } : {}) };
}

// Enabling the plugin can encounter records loaded before its receive hook.
// Capture only the original wire fields needed for a normal partial update;
// never feed normalized native embeds back into the raw embed converter.
export function receiveCachedMessage(message: any) {
    if (getWireMessage(message.channel_id, message.id)) return;
    const wire = rememberIncoming({
        id: message.id, channel_id: message.channel_id, author: { id: message.author.id },
        content: message.content, attachments: message.attachments,
        mentions: (message.mentions ?? []).map((mention: any) => typeof mention === "string" ? { id: mention } : mention),
        mention_roles: message.mentionRoles, mention_everyone: message.mentionEveryone,
        message_reference: message.messageReference, pinned: message.pinned, flags: message.flags
    }, message.channel_id);
    if (getWireMessage(wire.channel_id, wire.id)) refreshReceivedMessages(true);
}

const delivered = new Map<string, string>();
function signature(payload: any) { return JSON.stringify([payload.content, payload.attachments, payload.embeds, payload.mentions]); }
export function noteReceivedPayload(payload: any, channelId: string) { delivered.set(`${channelId}:${payload.id}`, signature(payload)); }

let refresh: ((retry: boolean) => void) | undefined;
export function refreshReceivedMessages(retry = false) { refresh?.(retry); }
export function installReceiveUpdates(native: SharedKeyNative, dispatch: (event: any) => any, receiving: () => boolean = () => false) {
    let live = true;
    let scheduled = false;
    const update = () => {
        if (!live || scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            if (!live || receiving()) return;
            for (const saved of allWireMessages()) {
                const wire = wireMessage(saved);
                const payload = receivedPayload(wire, wire.channel_id);
                const next = signature(payload);
                const id = `${wire.channel_id}:${wire.id}`;
                if (delivered.get(id) === next) continue;
                delivered.set(id, next);
                // A metadata update traverses Discord's normal MESSAGE_UPDATE
                // conversion too. Bypass our ingress wrapper to retain the wire.
                const stored = MessageStore.getMessage(wire.channel_id, wire.id);
                const message = { sharedkey_local_update: true, id: wire.id, channel_id: wire.channel_id, content: payload.content, attachments: payload.attachments, embeds: payload.embeds, mentions: payload.mentions ?? [], mention_everyone: payload.mention_everyone, mention_roles: payload.mention_roles, pinned: stored?.pinned ?? wire.pinned, flags: stored?.flags ?? wire.flags };
                dispatch({ type: "MESSAGE_UPDATE", message });
            }
        });
    };
    let retryQueued = false;
    const refreshMessages = (retry: boolean) => {
        retryQueued ||= retry;
        if (receiving()) return;
        retry = retryQueued; retryQueued = false;
        if (!retry) { update(); return; }
        const messages = allWireMessages();
        const preparing = prepareHistory(native, messages);
        if (preparing) void preparing.then(update); else update();
    };
    refresh = refreshMessages;
    const removePolicy = onReadingPolicyChange(refreshMessages);
    const removeFiles = onAttachmentReady(update);
    const removePreviews = onPreviewReady(update);
    return () => { live = false; removePolicy(); removeFiles(); removePreviews(); presented.clear(); delivered.clear(); if (refresh === refreshMessages) refresh = undefined; };
}
