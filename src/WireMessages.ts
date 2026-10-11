/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message } from "@vencord/discord-types";

const originals = new Map<string, any>();
const protectedIds = new Set<string>();
const referenceAuthors = new Map<string, string>();
export function rememberReference(message: any, channelId: string) {
    const reference = message?.referenced_message;
    if (reference?.id && reference.author?.id) referenceAuthors.set(`${reference.channel_id ?? message.message_reference?.channel_id ?? channelId}:${reference.id}`, reference.author.id);
}
export function rememberIncoming(source: any, channelId: string): any {
    const key = `${channelId}:${source.id}`;
    const previous = originals.get(key);
    const protectedMessage = source.content?.startsWith("[VCS1:") || source.content?.startsWith("[VCKX1:") || source.attachments?.some((file: any) => /\.vcs$/i.test(file.filename));
    if (!previous && !protectedMessage) return source;
    const wire = { ...previous, ...source, channel_id: channelId };
    originals.set(key, wire); protectedIds.add(key);
    rememberReference(wire, channelId);
    return wire;
}
export function wasEncrypted(channelId: string, messageId: string) { return protectedIds.has(`${channelId}:${messageId}`); }
export function getWireMessage(channelId: string, messageId: string): Message | undefined { return originals.get(`${channelId}:${messageId}`); }
export function wireMessage(message: Message): Message { return getWireMessage(message.channel_id, message.id) ?? message; }
export function referenceAuthor(channelId: string, messageId: string) { return getWireMessage(channelId, messageId)?.author?.id ?? referenceAuthors.get(`${channelId}:${messageId}`); }
export function allWireMessages(): any[] { return Array.from(originals.values()); }
export function clearWireMessages() { originals.clear(); protectedIds.clear(); referenceAuthors.clear(); }
