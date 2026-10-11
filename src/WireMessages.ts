/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message } from "@vencord/discord-types";

let originals = new WeakMap<object, Message>();
let reader: ((channelId: string, messageId: string) => Message | undefined) | undefined;
const referenceAuthors = new Map<string, string>();
export function rememberReference(message: any, channelId: string) {
    const reference = message?.referenced_message;
    if (!reference?.id || !reference.author?.id) return;
    if (referenceAuthors.size >= 1000) referenceAuthors.delete(referenceAuthors.keys().next().value!);
    referenceAuthors.set(`${reference.channel_id ?? message.message_reference?.channel_id ?? channelId}:${reference.id}`, reference.author.id);
}
export function referenceAuthor(channelId: string, messageId: string) { return getWireMessage(channelId, messageId)?.author?.id ?? referenceAuthors.get(`${channelId}:${messageId}`); }
export function setWireReader(next: typeof reader) { reader = next; }
export function getWireMessage(channelId: string, messageId: string) { const message = reader?.(channelId, messageId); return message ? wireMessage(message) : undefined; }
export function rememberWire(view: Message, wire: Message) { originals.set(view, wireMessage(wire)); }
export function wireMessage(message: Message): Message { return originals.get(message) ?? message; }
export function clearWireMessages() { originals = new WeakMap(); reader = undefined; referenceAuthors.clear(); }
