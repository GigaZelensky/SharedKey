/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Message } from "@vencord/discord-types";
import { ReferencedMessageStore } from "@webpack/common";

import { EXCHANGE_PREFIX } from "./exchangeWire";
import { cachedAttachmentInfo, encryptedAttachments, onAttachmentReady } from "./FileAttachments";
import { cachedPlaintext, markReplyView, requestPlaintext } from "./MessageView";
import { SharedKeyNative } from "./Options";

const replyRefreshers = new Set<() => void>();

export function refreshReplies() { replyRefreshers.forEach(refresh => refresh()); }

export function installReplyPreviews(native: SharedKeyNative, store = ReferencedMessageStore): () => void {
    let live = true;
    let views = new WeakMap<object, { text: string; view: any; }>();
    const requested = new Set<string>();
    const failed = new Set<string>();
    const originals = new Map<string, any>();
    const wrappers = new Map<string, any>();

    function project(reference: any) {
        const message: Message | undefined = reference?.message;
        const encryptedText = message?.content?.startsWith("[VCS1:");
        const exchange = message?.content?.startsWith(EXCHANGE_PREFIX);
        if (!message || reference.state !== 0 || (!encryptedText && !exchange && !encryptedAttachments(message).length)) return reference;
        const token = `${message.channel_id}:${message.author.id}:${message.content}`;
        let text = exchange ? "Encryption setup" : encryptedText ? cachedPlaintext(message) : message.content;
        if (encryptedText && text === undefined && !requested.has(token)) {
            requested.add(token);
            void requestPlaintext(native, message).then(() => { if (live) store.emitChange(); }).catch(() => {
                failed.add(token);
                if (live) store.emitChange();
            });
        }
        if (text === undefined) text = failed.has(token) ? "Unable to decrypt message" : "";
        const cached = views.get(reference);
        if (cached?.text === text) return cached.view;
        // Clone for the reply renderer only. Neither message store is modified.
        const attachments = message.attachments?.map(file => {
            const metadata = cachedAttachmentInfo(message.channel_id, file.id);
            return metadata ? { ...file, filename: metadata.filename, content_type: metadata.mime, size: metadata.size } : file;
        });
        const viewMessage = typeof message.merge === "function" ? message.merge({ content: text, attachments }) : Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content: text, attachments });
        markReplyView(viewMessage);
        const view = { ...reference, message: viewMessage };
        views.set(reference, { text, view });
        return view;
    }

    for (const name of ["getMessage", "getMessageByReference"]) {
        const original = (store as any)[name];
        if (typeof original !== "function") continue;
        const wrapped = function (this: unknown, ...args: any[]) { return project(original.apply(this, args)); };
        originals.set(name, original);
        wrappers.set(name, wrapped);
        (store as any)[name] = wrapped;
    }
    const refresh = () => { requested.clear(); failed.clear(); views = new WeakMap(); if (live) store.emitChange(); };
    replyRefreshers.add(refresh);
    const unsubscribeFiles = onAttachmentReady(() => { views = new WeakMap(); if (live) store.emitChange(); });
    return () => {
        live = false;
        unsubscribeFiles();
        replyRefreshers.delete(refresh);
        for (const [name, original] of originals) if ((store as any)[name] === wrappers.get(name)) (store as any)[name] = original;
        store.emitChange();
    };
}
