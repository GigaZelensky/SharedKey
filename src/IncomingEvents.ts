/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Incoming raw-message actions used by Discord's stores. Keep outbound composer
// actions out of this list: decrypted payloads must never reach a send action.
export const incomingEvents = new Set([
    "MESSAGE_CREATE", "MESSAGE_UPDATE", "LOAD_MESSAGES_SUCCESS", "LOAD_MESSAGES_AROUND_SUCCESS",
    "LOAD_PINNED_MESSAGES_SUCCESS", "LOAD_RECENT_MENTIONS_SUCCESS", "SEARCH_MESSAGES_SUCCESS",
    "MOD_VIEW_SEARCH_MESSAGES_SUCCESS", "CONVERSATION_MESSAGES_FETCH_SUCCESS", "CHANNEL_CONVERSATIONS_FETCH_SUCCESS"
]);

// History/search/pins have different envelopes (including nested arrays). Walk
// only plain incoming data, preserving the envelope and untouched objects.
export function mapIncomingMessages(value: any, channelId: string | undefined, visit: (message: any, channelId: string) => any, depth = 0): any {
    if (!value || typeof value !== "object" || depth > 16) return value;
    if (Array.isArray(value)) {
        const result = value.map(item => mapIncomingMessages(item, channelId, visit, depth + 1));
        return result.some((item, i) => item !== value[i]) ? result : value;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    const channel = value.channel_id ?? value.channelId ?? channelId;
    let mapped = value;
    if (channel && value.id && (value.author || typeof value.content === "string" || Array.isArray(value.attachments))) mapped = visit(value, channel);
    let copied = false;
    for (const [key, child] of Object.entries(mapped)) {
        if (!child || typeof child !== "object") continue;
        const next = mapIncomingMessages(child, channel, visit, depth + 1);
        if (next !== child) { if (!copied) { mapped = { ...mapped }; copied = true; } mapped[key] = next; }
    }
    return mapped;
}
