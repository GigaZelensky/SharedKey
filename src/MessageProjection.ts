/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message } from "@vencord/discord-types";
import { MessageStore, UserStore } from "@webpack/common";

import { EXCHANGE_PREFIX } from "./exchangeWire";
import { attachmentView, encryptedAttachments, onAttachmentReady } from "./FileAttachments";
import { mentionsUser } from "./localMentions";
import { cachedPlaintext, decryptionFailed, onPlaintextReady } from "./MessageView";
import { cachedPreviewEmbeds, onPreviewReady } from "./PreviewEmbeds";
import { clearWireMessages, referenceAuthor, rememberWire, setWireReader, wireMessage } from "./WireMessages";

function copy<T extends object>(source: T, changes: Record<string, unknown>): T {
    const descriptors = Object.getOwnPropertyDescriptors(source);
    for (const [key, value] of Object.entries(changes)) (descriptors as Record<string, PropertyDescriptor>)[key] = { value, enumerable: true, writable: true, configurable: true };
    return Object.create(Object.getPrototypeOf(source), descriptors);
}

let epoch = 0;
let views = new WeakMap<object, { epoch: number; view: Message; text?: string; user?: string; }>();
const refreshers = new Set<() => void>();
export function refreshProjectedMessages() { epoch++; refreshers.forEach(fn => fn()); }

export function projectMessage(source: Message | undefined): Message | undefined {
    if (!source) return source;
    const message = wireMessage(source);
    const encrypted = message.content?.startsWith("[VCS1:");
    const setup = message.content?.startsWith(EXCHANGE_PREFIX);
    const encryptedFiles = encryptedAttachments(message);
    if (!encrypted && !setup && !encryptedFiles.length) return source;
    const user = UserStore.getCurrentUser()?.id;
    const previous = views.get(message);
    if (previous?.epoch === epoch && previous.user === user) return previous.view;
    const text = encrypted ? cachedPlaintext(message) ?? previous?.text : message.content;
    const failed = encrypted && text === undefined && decryptionFailed(message);
    const content = setup ? "Encryption setup" : encrypted ? text ?? (failed ? "Unable to decrypt. Check this chat's key." : "") : message.content;
    const fileIds = new Set(encryptedFiles.map(file => file.id));
    const attachments = (message.attachments ?? []).flatMap(file => {
        if (!fileIds.has(file.id) || file.size > 64 * 1024 * 1024 + 4200) return [file];
        const local = attachmentView(message.channel_id, file.id);
        // Fragments do not change blob lookup, and preserve the extension that
        // Discord's native GIF/AVIF/WebP detection expects in image URLs.
        const url = local ? local.url + "#" + encodeURIComponent(local.filename) : "";
        return local ? [{ ...file, filename: local.filename, url, proxy_url: url, content_type: local.mime, size: local.blob.size, width: local.width, height: local.height, spoiler: !!file.spoiler || file.filename.startsWith("SPOILER_") }] : [];
    });
    const reference = message.messageReference;
    const referencedAuthor = reference?.message_id ? referenceAuthor(reference.channel_id ?? message.channel_id, reference.message_id) : undefined;
    const mentioned = !!message.mentioned || mentionsUser(content, user) || (!!user && referencedAuthor === user);
    const changes = { content, attachments, embeds: [...(message.embeds ?? []), ...(encrypted && text !== undefined ? cachedPreviewEmbeds(text) : [])], mentioned };
    const view = typeof message.merge === "function" ? message.merge(changes) : copy(message, changes);
    rememberWire(view, message);
    views.set(message, { epoch, view, text, user });
    return view;
}

export function installMessageProjection(store = MessageStore): () => void {
    let live = true;
    let scheduled = false;
    const channelViews = new WeakMap<object, { epoch: number; view: any; }>();
    const originals = new Map<string, any>();
    const wrappers = new Map<string, any>();
    const readMessage = store.getMessage;
    setWireReader((channelId, messageId) => readMessage.call(store, channelId, messageId));
    function refresh() {
        if (scheduled || !live) return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; if (live) store.emitChange(); });
    }
    refreshers.add(refresh);
    const unsubscribeText = onPlaintextReady(refreshProjectedMessages);
    const unsubscribeFiles = onAttachmentReady(refreshProjectedMessages);
    const unsubscribePreviews = onPreviewReady(refreshProjectedMessages);
    for (const name of ["getMessage", "getLastMessage", "getLastEditableMessage", "getLastNonCurrentUserMessage", "getLastChatCommandMessage"]) {
        const original = (store as any)[name];
        if (typeof original !== "function") continue;
        const wrapped = function (this: unknown, ...args: any[]) { return projectMessage(original.apply(this, args)); };
        originals.set(name, original); wrappers.set(name, wrapped); (store as any)[name] = wrapped;
    }
    const original = store.getMessages;
    if (typeof original === "function") {
        const wrapped = function (this: unknown, ...args: any[]) {
            const raw = original.apply(this, args as [string]);
            if (!raw) return raw;
            const cached = channelViews.get(raw);
            if (cached?.epoch === epoch) return cached.view;
            const array = raw._array.map(message => projectMessage(message)!);
            if (array.every((message, i) => message === raw._array[i])) return raw;
            const map = (values: Record<string, Message>) => Object.fromEntries(Object.entries(values ?? {}).map(([id, message]) => [id, projectMessage(message)]));
            const cache = (value: any) => value ? copy(value, { _messages: value._messages?.map(projectMessage), _map: map(value._map) }) : value;
            const view = copy(raw, { _array: array, _map: map(raw._map), _before: cache(raw._before), _after: cache(raw._after) });
            channelViews.set(raw, { epoch, view });
            return view;
        };
        originals.set("getMessages", original); wrappers.set("getMessages", wrapped); store.getMessages = wrapped;
    }
    refresh();
    return () => {
        live = false; refreshers.delete(refresh); unsubscribeText(); unsubscribeFiles(); unsubscribePreviews();
        for (const [name, original] of originals) if ((store as any)[name] === wrappers.get(name)) (store as any)[name] = original;
        views = new WeakMap(); clearWireMessages(); store.emitChange();
    };
}
