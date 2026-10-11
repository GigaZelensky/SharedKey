/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Message } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { FluxDispatcher, MessageStore, showToast } from "@webpack/common";

import { EXCHANGE_PREFIX } from "./exchangeWire";
import { cachedAttachmentInfo } from "./FileAttachments";
import { cachedPlaintext, prepareHistory, requestPlaintext } from "./MessageView";
import { SharedKeyNative } from "./Options";
import { getWireMessage, rememberReference, wireMessage } from "./WireMessages";

const contexts = new Map<string, Message>();
const edits = new Set<string>();
const encrypted = (text: unknown): text is string => typeof text === "string" && text.startsWith("[VCS1:");
const NativeNotifications = findByPropsLazy("showNotification", "playNotificationSound");

export function encryptedEdit(channelId: string, messageId: string): boolean {
    const view = MessageStore.getMessage(channelId, messageId);
    const stored = view ? wireMessage(view) : undefined;
    return edits.has(`${channelId}:${messageId}`) || encrypted(stored?.content)
        || !!stored?.attachments?.some(file => cachedAttachmentInfo(channelId, file.id));
}

export function installMessagePresentation(native: SharedKeyNative) {
    const original = FluxDispatcher.dispatch as (...args: any[]) => any;
    const originalNotification = NativeNotifications.showNotification;
    let live = true;
    let editGeneration = 0;
    const queues = new Map<string, Promise<any>>();
    function notificationBody(body: string, tracking: any = {}): string | Promise<string> {
        if (body.includes(EXCHANGE_PREFIX)) return "Encryption setup";
        const fragment = body.match(/\[VCS1:[A-Za-z0-9_-]+\]?/)?.[0];
        const candidate = tracking.channel_id && tracking.message_id ? MessageStore.getMessage(tracking.channel_id, tracking.message_id) : undefined;
        const stored = candidate ? wireMessage(candidate) : undefined;
        const prefix = fragment?.replace(/\]$/, "");
        const message = stored && encrypted(stored.content) && (!prefix || stored.content.startsWith(prefix)) ? stored
            : fragment ? contexts.get(fragment) ?? (prefix && prefix.length >= 22 ? Array.from(contexts.values()).find(m => m.content.startsWith(prefix)) : undefined) : undefined;
        if (!message) return "Encrypted message";
        const present = (text: string) => text.trim() || (message.attachments?.length ? "Attachment" : "Message");
        const cached = cachedPlaintext(message);
        if (cached !== undefined) return present(cached);
        return requestPlaintext(native, message).then(present, () => "Encrypted message");
    }
    function showNotification(this: unknown, ...args: any[]) {
        const body = args[2];
        if (!live || typeof body !== "string" || (!body.includes("[VCS1:") && !body.includes(EXCHANGE_PREFIX))) return originalNotification.apply(this, args);
        // Message notifications call this directly from NotificationStore,
        // without emitting NOTIFICATION_CREATE. Keep Discord's native renderer,
        // sound, click/close callbacks and returned notification handle intact.
        const deliver = (text: string) => { if (live) return originalNotification.apply(this, [args[0], args[1], text, ...args.slice(3)]); };
        const text = notificationBody(body, args[3]);
        return typeof text === "string" ? deliver(text) : text.then(deliver);
    }
    NativeNotifications.showNotification = showNotification;
    function dispatchNow(this: unknown, event: any, ...args: any[]) {
        if (!live) return original.call(this, event, ...args);
        if (event.type === "MESSAGE_LOAD_SUCCESS" && Array.isArray(event.messages)) {
            const page: Message[] = [];
            for (const message of event.messages) {
                rememberReference(message, message.channel_id ?? event.channelId);
                page.push({ ...message, channel_id: message.channel_id ?? event.channelId });
                if (message.referenced_message) page.push({ ...message.referenced_message, channel_id: message.referenced_message.channel_id ?? message.message_reference?.channel_id ?? event.channelId });
            }
            const preparing = prepareHistory(native, page);
            if (preparing) return preparing.then(() => original.call(this, event, ...args));
        }
        if ((event.type === "MESSAGE_CREATE" || event.type === "MESSAGE_UPDATE") && encrypted(event.message?.content)) {
            const source = event.message;
            const channelId = source.channel_id ?? event.channelId;
            const author = source.author ?? getWireMessage(channelId, source.id)?.author;
            const message = { ...source, channel_id: channelId, author } as Message;
            if (!message.author?.id) return original.call(this, event, ...args);
            if (contexts.size >= 500) contexts.delete(contexts.keys().next().value!);
            contexts.set(message.content, message);
            const preparing = prepareHistory(native, [message]);
            if (preparing) return preparing.then(() => original.call(this, event, ...args));
        }
        if (event.type === "MESSAGE_END_EDIT") {
            editGeneration++;
            if (event.messageId) edits.delete(`${event.channelId}:${event.messageId}`);
            else for (const key of edits) if (key.startsWith(`${event.channelId}:`)) edits.delete(key);
        }
        if (event.type === "MESSAGE_START_EDIT") {
            const sequence = ++editGeneration;
            const view = MessageStore.getMessage(event.channelId, event.messageId);
            const stored = view ? wireMessage(view) : undefined;
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
        if (event.type === "NOTIFICATION_CREATE" && typeof event.body === "string" && (event.body.includes("[VCS1:") || event.body.includes(EXCHANGE_PREFIX))) {
            const deliver = (body: string) => { if (live) return original.call(this, { ...event, body }, ...args); };
            const text = notificationBody(event.body, event.trackingProps);
            return typeof text === "string" ? deliver(text) : text.then(deliver);
        }
        return original.call(this, event, ...args);
    }
    function dispatch(this: unknown, event: any, ...args: any[]) {
        if (live && event.message) rememberReference(event.message, event.channelId ?? event.message.channel_id);
        if (live && (event.type === "MESSAGE_CREATE" || event.type === "MESSAGE_UPDATE") && encrypted(event.message?.content) && event.message.author?.id) {
            const message = { ...event.message, channel_id: event.message.channel_id ?? event.channelId } as Message;
            if (contexts.size >= 500) contexts.delete(contexts.keys().next().value!);
            contexts.set(message.content, message);
        }
        const channelId = event.channelId ?? event.channel_id ?? event.message?.channel_id;
        const ordered = live && channelId && ["MESSAGE_LOAD_SUCCESS", "MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK"].includes(event.type);
        if (!ordered) return dispatchNow.call(this, event, ...args);
        const previous = queues.get(channelId);
        const result = previous ? previous.catch(() => {}).then(() => dispatchNow.call(this, event, ...args)) : dispatchNow.call(this, event, ...args);
        if (!result || typeof result.then !== "function") return result;
        const queued = Promise.resolve(result);
        queues.set(channelId, queued);
        void queued.then(() => { if (queues.get(channelId) === queued) queues.delete(channelId); }, () => { if (queues.get(channelId) === queued) queues.delete(channelId); });
        return queued;
    }
    FluxDispatcher.dispatch = dispatch as typeof original;
    return () => {
        live = false;
        editGeneration++;
        contexts.clear();
        edits.clear();
        if (FluxDispatcher.dispatch === dispatch) FluxDispatcher.dispatch = original;
        if (NativeNotifications.showNotification === showNotification) NativeNotifications.showNotification = originalNotification;
    };
}
