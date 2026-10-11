/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Message } from "@vencord/discord-types";
import { FluxDispatcher, MessageStore, showToast } from "@webpack/common";

import { EXCHANGE_PREFIX } from "./exchangeWire";
import { cachedAttachmentInfo } from "./FileAttachments";
import { cachedPlaintext, requestPlaintext } from "./MessageView";
import { SharedKeyNative } from "./Options";

const contexts = new Map<string, Message>();
const edits = new Set<string>();
const encrypted = (text: unknown): text is string => typeof text === "string" && text.startsWith("[VCS1:");

export function encryptedEdit(channelId: string, messageId: string): boolean {
    const stored = MessageStore.getMessage(channelId, messageId);
    return edits.has(`${channelId}:${messageId}`) || encrypted(stored?.content)
        || !!stored?.attachments?.some(file => cachedAttachmentInfo(channelId, file.id));
}

export function installMessagePresentation(native: SharedKeyNative) {
    const original = FluxDispatcher.dispatch as (...args: any[]) => any;
    let live = true;
    let editGeneration = 0;
    function dispatch(this: unknown, event: any, ...args: any[]) {
        if ((event.type === "MESSAGE_CREATE" || event.type === "MESSAGE_UPDATE") && encrypted(event.message?.content) && event.message?.author?.id) {
            const message = event.message as Message;
            if (contexts.size >= 500) contexts.delete(contexts.keys().next().value!);
            contexts.set(message.content, message);
            // Prime the cache before notification handlers consume this event.
            void requestPlaintext(native, message).catch(() => {});
        }
        if (event.type === "MESSAGE_END_EDIT") {
            editGeneration++;
            if (event.messageId) edits.delete(`${event.channelId}:${event.messageId}`);
            else for (const key of edits) if (key.startsWith(`${event.channelId}:`)) edits.delete(key);
        }
        if (event.type === "MESSAGE_START_EDIT") {
            const sequence = ++editGeneration;
            const stored = MessageStore.getMessage(event.channelId, event.messageId);
            if (stored?.content?.startsWith(EXCHANGE_PREFIX)) { showToast("Setup messages cannot be edited. Start a new exchange in encryption options."); return; }
            const content = encrypted(event.content) ? event.content : stored?.content;
            if (encrypted(content)) {
                const message = stored ? { ...stored, content } as Message : contexts.get(content);
                if (!message) { showToast("Cannot load the encrypted message for editing."); return; }
                edits.add(`${event.channelId}:${event.messageId}`);
                const cached = cachedPlaintext(message);
                if (cached !== undefined) return original.call(this, { ...event, content: cached }, ...args);
                return requestPlaintext(native, message).then(text => {
                    if (live && sequence === editGeneration) return original.call(this, { ...event, content: text }, ...args);
                }).catch(() => { if (live) showToast("Check this chat's key before editing this message."); });
            }
        }
        if (event.type === "NOTIFICATION_CREATE" && typeof event.body === "string" && event.body.includes(EXCHANGE_PREFIX)) {
            return original.call(this, { ...event, body: "Encryption setup" }, ...args);
        }
        if (event.type === "NOTIFICATION_CREATE" && typeof event.body === "string" && event.body.includes("[VCS1:")) {
            const fragment = event.body.match(/\[VCS1:[A-Za-z0-9_-]+\]?/)?.[0];
            const tracking = event.trackingProps ?? {};
            const stored = tracking.channel_id && tracking.message_id ? MessageStore.getMessage(tracking.channel_id, tracking.message_id) : undefined;
            const message = stored && encrypted(stored.content) ? stored
                : fragment ? contexts.get(fragment) ?? Array.from(contexts.values()).find(m => m.content.startsWith(fragment.replace(/\]$/, ""))) : undefined;
            const deliver = (body: string) => { if (live) return original.call(this, { ...event, body }, ...args); };
            if (!message) return deliver("Encrypted message");
            const present = (text: string) => text.trim() || (message.attachments?.length ? "Attachment" : "Message");
            const cached = cachedPlaintext(message);
            if (cached !== undefined) return deliver(present(cached));
            return requestPlaintext(native, message).then(text => deliver(present(text)), () => deliver("Encrypted message"));
        }
        return original.call(this, event, ...args);
    }
    FluxDispatcher.dispatch = dispatch as typeof original;
    return () => {
        live = false;
        editGeneration++;
        contexts.clear();
        edits.clear();
        if (FluxDispatcher.dispatch === dispatch) FluxDispatcher.dispatch = original;
    };
}
