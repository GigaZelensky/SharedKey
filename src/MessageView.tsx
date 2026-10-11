/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message } from "@vencord/discord-types";

import { clearAttachmentCache } from "./FileAttachments";
import type { SharedKeyNative } from "./Options";
import { clearPreviewEmbeds } from "./PreviewEmbeds";

const plaintext = new Map<string, string>();
const failures = new Set<string>();
const pending = new Map<string, Promise<string>>();
const cacheListeners = new Set<() => void>();
let generation = 0;
export function onPlaintextReady(callback: () => void) { cacheListeners.add(callback); return () => { cacheListeners.delete(callback); }; }
export function decryptionFailed(message: Message) { return failures.has(messageToken(message)); }

export function clearMessageCache() { generation++; plaintext.clear(); failures.clear(); pending.clear(); clearAttachmentCache(); clearPreviewEmbeds(); }
export function retryFailedMessages() { failures.clear(); }
function messageToken(message: Message) { return `${message.channel_id}:${message.author.id}:${message.content}`; }
function rememberFailure(token: string) {
    if (failures.size >= 500) failures.delete(failures.values().next().value!);
    failures.add(token);
}

export function rememberPlaintext(channelId: string, authorId: string, content: string, text: string) {
    if (plaintext.size >= 500) plaintext.delete(plaintext.keys().next().value!);
    plaintext.set(`${channelId}:${authorId}:${content}`, text);
    failures.delete(`${channelId}:${authorId}:${content}`);
    cacheListeners.forEach(callback => callback());
}

// Prime a history page before its original Flux event reaches Discord's stores
// and virtual list. Wire messages remain untouched; only the local view cache is
// filled, including failures so those rows start at their final error height.
export function prepareHistory(native: SharedKeyNative, messages: Message[]): Promise<void> | undefined {
    const missing = new Map<string, Message>();
    const waits: Promise<unknown>[] = [];
    for (const message of messages) {
        if (!message.channel_id || !message.author?.id || !message.content?.startsWith("[VCS1:")) continue;
        const token = messageToken(message);
        if (!plaintext.has(token) && !failures.has(token)) {
            const existing = pending.get(token);
            if (existing) waits.push(existing.catch(() => {})); else missing.set(token, message);
        }
    }
    if (!missing.size && !waits.length) return;
    const started = generation;
    const groups = new Map<string, Message[]>();
    for (const message of missing.values()) {
        const group = groups.get(message.channel_id) ?? [];
        group.push(message); groups.set(message.channel_id, group);
    }
    return Promise.all([...waits, ...Array.from(groups, async ([channelId, group]) => {
        for (let offset = 0; offset < group.length; offset += 200) {
            const chunk = group.slice(offset, offset + 200);
            if (typeof native.decryptMessages !== "function") {
                await Promise.all(chunk.map(message => decrypt(native, message, messageToken(message)).catch(() => {})));
                continue;
            }
            try {
                const results = await native.decryptMessages(channelId, chunk.map(message => ({ authorId: message.author.id, content: message.content })));
                if (started !== generation) return;
                chunk.forEach((message, i) => {
                    if (typeof results[i]?.text === "string") rememberPlaintext(channelId, message.author.id, message.content, results[i].text!);
                    else rememberFailure(messageToken(message));
                });
            } catch { await Promise.all(chunk.map(message => decrypt(native, message, messageToken(message)).catch(() => {}))); }
        }
    })]).then(() => {});
}

export function cachedPlaintext(message: Message) { return plaintext.get(`${message.channel_id}:${message.author.id}:${message.content}`); }
export function requestPlaintext(native: SharedKeyNative, message: Message) { return decrypt(native, message, `${message.channel_id}:${message.author.id}:${message.content}`); }


function decrypt(native: SharedKeyNative, message: Message, token: string): Promise<string> {
    if (plaintext.has(token)) return Promise.resolve(plaintext.get(token)!);
    if (failures.has(token)) return Promise.reject(new Error("Unable to decrypt message."));
    let request = pending.get(token);
    if (!request) {
        const currentGeneration = generation;
        request = native.decryptMessage(message.channel_id, message.author.id, message.content).then(text => {
            if (currentGeneration === generation) {
                if (plaintext.size >= 500) plaintext.delete(plaintext.keys().next().value!);
                plaintext.set(token, text);
                failures.delete(token);
                cacheListeners.forEach(callback => callback());
            }
            return text;
        }, error => {
            if (currentGeneration === generation) { rememberFailure(token); cacheListeners.forEach(callback => callback()); }
            throw error;
        });
        pending.set(token, request);
        const complete = () => { if (pending.get(token) === request) pending.delete(token); };
        void request.then(complete, complete);
    }
    return request;
}
