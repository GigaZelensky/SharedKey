/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message } from "@vencord/discord-types";
import { ReferencedMessageStore } from "@webpack/common";

import { encryptedAttachments, onAttachmentReady } from "./FileAttachments";
import { projectMessage } from "./MessageProjection";
import { cachedPlaintext, onPlaintextReady, requestPlaintext } from "./MessageView";
import type { SharedKeyNative } from "./Options";
import { rememberWire, wireMessage } from "./WireMessages";

const refreshers = new Set<() => void>();
export function refreshReplies() { refreshers.forEach(fn => fn()); }

export function installReplyPreviews(native: SharedKeyNative, store = ReferencedMessageStore): () => void {
    let live = true;
    let scheduled = false;
    let views = new WeakMap<object, { message: Message; view: any; }>();
    const requested = new Set<string>();
    const originals = new Map<string, any>();
    const wrappers = new Map<string, any>();
    function notify() {
        if (!live || scheduled) return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; if (live) store.emitChange(); });
    }
    function project(reference: any) {
        if (!reference?.message || reference.state !== 0) return reference;
        const wire = wireMessage(reference.message);
        if (wire.content?.startsWith("[VCS1:") && cachedPlaintext(wire) === undefined) {
            const token = `${wire.channel_id}:${wire.author.id}:${wire.content}`;
            if (!requested.has(token)) {
                requested.add(token); void requestPlaintext(native, wire).then(notify, notify);
            }
        }
        let message = projectMessage(reference.message)!;
        if (message === reference.message) return reference;
        if (encryptedAttachments(wire).length && !message.attachments.length) {
            message = typeof message.merge === "function" ? message.merge({ attachments: wire.attachments }) : Object.assign(Object.create(Object.getPrototypeOf(message)), message, { attachments: wire.attachments });
            rememberWire(message, wire);
        }
        const cached = views.get(reference);
        if (cached?.message === message) return cached.view;
        const view = { ...reference, message };
        views.set(reference, { message, view });
        return view;
    }
    for (const name of ["getMessage", "getMessageByReference"]) {
        const original = (store as any)[name];
        if (typeof original !== "function") continue;
        const wrapped = function (this: unknown, ...args: any[]) { return project(original.apply(this, args)); };
        originals.set(name, original); wrappers.set(name, wrapped); (store as any)[name] = wrapped;
    }
    const refresh = () => { requested.clear(); views = new WeakMap(); notify(); };
    refreshers.add(refresh);
    const unsubscribeFiles = onAttachmentReady(notify);
    const unsubscribeText = onPlaintextReady(notify);
    return () => {
        live = false; refreshers.delete(refresh); unsubscribeFiles(); unsubscribeText();
        for (const [name, original] of originals) if ((store as any)[name] === wrappers.get(name)) (store as any)[name] = original;
        store.emitChange();
    };
}
