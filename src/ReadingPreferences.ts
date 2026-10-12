/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get, set } from "@api/DataStore";

import type { SharedKeyNative } from "./Options";
import type { PreviewMode } from "./ReadingPolicy";

interface Preferences { reading: boolean; previews: PreviewMode; }
interface Storage { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown>; }
const storageKey = "SharedKey_reading_preferences_v1";
const valid = (value: any): value is Preferences => typeof value?.reading === "boolean" && ["manual", "automatic", "never"].includes(value.previews);

// These are local display preferences, not encryption keys or synced settings.
// Keeping them in the renderer also works after a reload with an older native
// process. Native vault preferences remain the defaults until changed here.
export function withReadingPreferences(backend: SharedKeyNative, storage: Storage = { get, set }): SharedKeyNative {
    let saved: Record<string, Preferences> | undefined;
    let loading: Promise<void> | undefined;
    let writing = Promise.resolve();
    async function load() {
        if (saved) return;
        loading ??= storage.get(storageKey).then(value => {
            if (value != null && (typeof value !== "object" || Array.isArray(value))) throw new Error("Could not read local viewing preferences.");
            const entries = Object.entries(value ?? {});
            if (entries.some(([id, preferences]) => !/^\d+$/.test(id) || !valid(preferences))) throw new Error("Invalid local viewing preferences.");
            saved = Object.fromEntries(entries);
        }).catch(error => { loading = undefined; throw error; });
        await loading;
    }
    async function decorate(channelId: string, info: any) {
        await load();
        const preferences = saved![channelId] ?? { reading: info.reading ?? true, previews: info.previews ?? "manual" };
        return { ...info, ...preferences };
    }
    const native = new Proxy({} as any, { get: (overrides, key) => Object.hasOwn(overrides, key) ? overrides[key] : (backend as any)[key] });
    for (const method of ["channelInfo", "setEnabled", "toggleEnabled", "saveKey", "setColor", "setMethod", "savePassword", "verifyIdentity", "forgetPeerIdentity"]) {
        const original = (backend as any)[method];
        if (typeof original === "function") native[method] = async (channelId: string, ...args: any[]) => decorate(channelId, await (backend as any)[method](channelId, ...args));
    }
    for (const method of ["startExchange", "handleExchange"]) {
        const original = (backend as any)[method];
        if (typeof original === "function") native[method] = async (channelId: string, ...args: any[]) => {
            const result = await (backend as any)[method](channelId, ...args);
            return { ...result, info: await decorate(channelId, result.info) };
        };
    }
    if (typeof backend.channelStates === "function") native.channelStates = async () => {
        const states = await backend.channelStates();
        return Object.fromEntries(await Promise.all(Object.entries(states).map(async ([id, info]) => [id, await decorate(id, info)])));
    };
    native.setReadingOptions = (channelId: string, reading: boolean, previews: PreviewMode) => {
        if (!/^\d+$/.test(channelId) || !valid({ reading, previews })) return Promise.reject(new Error("Invalid viewing preferences."));
        const operation = writing.catch(() => {}).then(async () => {
            await load();
            const info = await backend.channelInfo(channelId);
            const next = { ...saved, [channelId]: { reading, previews } };
            await storage.set(storageKey, next);
            saved = next;
            return decorate(channelId, info);
        });
        writing = operation.then(() => {}, () => {});
        return operation;
    };
    return native;
}
