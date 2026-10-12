/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SharedKeyNative } from "./Options";

export type PreviewMode = "manual" | "automatic" | "never";
interface Policy { reading: boolean; previews: PreviewMode; }
const policies = new Map<string, Policy>();
const pending = new Map<string, Promise<void>>();
const grants = new Set<string>();
const listeners = new Set<(readingChanged: boolean) => void>();
let generation = 0;
const token = (message: any) => `${message.channel_id}:${message.id}:${message.content}`;
export function readingEnabled(channelId: string) { return policies.get(channelId)?.reading ?? false; }
export function previewMode(channelId: string): PreviewMode { return policies.get(channelId)?.previews ?? "automatic"; }
export function previewsAllowed(message: any) {
    return readingEnabled(message.channel_id) && (previewMode(message.channel_id) === "automatic" || (previewMode(message.channel_id) === "manual" && grants.has(token(message))));
}
export function onReadingPolicyChange(callback: (readingChanged: boolean) => void) { listeners.add(callback); return () => { listeners.delete(callback); }; }
export function rememberReadingPolicy(channelId: string, info: { reading?: boolean; previews?: PreviewMode; }) {
    const next = { reading: info.reading ?? true, previews: info.previews ?? "automatic" };
    const previous = policies.get(channelId);
    if (previous?.reading === next.reading && previous.previews === next.previews) return;
    policies.set(channelId, next);
    for (const key of grants) if (key.startsWith(channelId + ":")) grants.delete(key);
    listeners.forEach(callback => callback(previous?.reading !== next.reading));
}
export function ensureReadingPolicy(native: SharedKeyNative, channelId: string): Promise<void> | undefined {
    if (policies.has(channelId)) return;
    let request = pending.get(channelId);
    if (!request) {
        const started = generation;
        request = native.channelInfo(channelId).then(info => {
            if (started === generation && !policies.has(channelId)) rememberReadingPolicy(channelId, info);
        }).catch(() => { /* Unknown policy stays closed; a later mount can retry. */ }).finally(() => { if (pending.get(channelId) === request) pending.delete(channelId); });
        pending.set(channelId, request);
    }
    return request;
}
export function allowMessagePreview(message: any) {
    if (!readingEnabled(message.channel_id) || previewMode(message.channel_id) === "never") return;
    grants.add(token(message)); listeners.forEach(callback => callback(false));
}
export function clearReadingPolicies() { generation++; policies.clear(); pending.clear(); grants.clear(); }
