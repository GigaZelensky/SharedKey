/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { CspPolicies } from "@main/csp";
import { SETTINGS_DIR } from "@main/utils/constants";
import { BrowserWindow, dialog, IpcMainInvokeEvent, safeStorage } from "electron";

import { attachmentUrl, downloadEncrypted, mediaType, streamEncryptedToDisk } from "./attachmentTransport";
import { checkId, decryptFile, decryptText, encryptFile, encryptText, FILE_MAGIC, generateKey, keyId, MAX_FILE_BYTES, parseKey, TEXT_PREFIX } from "./crypto";
import { resolveGif } from "./gifResolver";

CspPolicies["*.klipy.com"] = ["img-src", "media-src"];

export async function resolveGifPreview(_: IpcMainInvokeEvent, url: string) { return resolveGif(url); }

interface ChannelConfig { enabled: boolean; current: string; keys: Record<string, string>; color?: string; }
type Vault = Record<string, ChannelConfig>;
const vaultPath = join(SETTINGS_DIR, "sharedkey-vault.bin");
let vault: Vault | undefined;
const issuedEnvelopes = new Set<string>();

function load(): Vault {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) {
        throw new Error("OS protected key storage is unavailable. SharedKey will block sending until it is available.");
    }
    if (!vault) {
        const candidate: Vault = existsSync(vaultPath) ? JSON.parse(safeStorage.decryptString(readFileSync(vaultPath))) : {};
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Cannot read the key vault.");
        for (const [channelId, c] of Object.entries(candidate)) {
            checkId(channelId);
            if (!c || typeof c.enabled !== "boolean" || typeof c.current !== "string" || !c.keys || typeof c.keys !== "object" || Array.isArray(c.keys)) throw new Error("Invalid key vault. Sending was blocked.");
            if (c.color !== undefined && !/^#[0-9a-f]{6}$/i.test(c.color)) throw new Error("Invalid message color in key vault.");
            for (const [id, key] of Object.entries(c.keys)) if (typeof key !== "string" || keyId(key) !== id) throw new Error("Invalid key vault. Sending was blocked.");
            if (!Object.hasOwn(c.keys, c.current)) throw new Error("Invalid key vault. Sending was blocked.");
        }
        vault = candidate;
    }
    return vault;
}

function persist(next: Vault): void {
    const encrypted = safeStorage.encryptString(JSON.stringify(next));
    mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(vaultPath + ".tmp", encrypted, { mode: 0o600 });
    renameSync(vaultPath + ".tmp", vaultPath);
    vault = next;
}

function config(channelId: string): ChannelConfig | undefined {
    checkId(channelId);
    return load()[channelId];
}

export function channelInfo(_: IpcMainInvokeEvent, channelId: string) {
    const c = config(channelId);
    return { enabled: c?.enabled ?? false, fingerprint: c?.current ?? "", keyCount: Object.keys(c?.keys ?? {}).length, color: c?.color ?? "#7d52ff" };
}

// Rendering hints only: never expose the saved keys through this snapshot.
export function channelStates(_: IpcMainInvokeEvent) {
    return Object.fromEntries(Object.entries(load()).map(([id, c]) => [id, { enabled: c.enabled, color: c.color ?? "#7d52ff" }]));
}

export function newKey(_: IpcMainInvokeEvent): string { return generateKey(); }

export function saveKey(_: IpcMainInvokeEvent, channelId: string, key: string) {
    checkId(channelId);
    key = key.trim();
    parseKey(key);
    const all = load();
    const keys = { ...all[channelId]?.keys, [keyId(key)]: key };
    if (Object.keys(keys).length > 32) throw new Error("This chat has 32 saved keys. Use a new chat for further key rotation.");
    persist({ ...all, [channelId]: { ...all[channelId], enabled: all[channelId]?.enabled ?? true, current: keyId(key), keys } });
    return channelInfo(_, channelId);
}

export function setEnabled(_: IpcMainInvokeEvent, channelId: string, enabled: boolean) {
    const c = config(channelId);
    if (!c) throw new Error("Save a shared key first.");
    persist({ ...load(), [channelId]: { ...c, enabled: Boolean(enabled) } });
    return channelInfo(_, channelId);
}

export function toggleEnabled(_: IpcMainInvokeEvent, channelId: string) {
    const c = config(channelId);
    if (!c) return { ...channelInfo(_, channelId), needsKey: true };
    return { ...setEnabled(_, channelId, !c.enabled), needsKey: false };
}

export function setColor(_: IpcMainInvokeEvent, channelId: string, color: string) {
    const c = config(channelId);
    if (!c) throw new Error("Save a shared key first.");
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Invalid message color.");
    persist({ ...load(), [channelId]: { ...c, color: color.toLowerCase() } });
    return channelInfo(_, channelId);
}

export function revealKey(_: IpcMainInvokeEvent, channelId: string): string {
    const c = config(channelId);
    return c?.keys[c.current] ?? "";
}

export function prepareOutgoing(_: IpcMainInvokeEvent, channelId: string, authorId: string, content: string, maxLength = 2000, forceEncrypted = false) {
    const c = config(channelId);
    if (!c?.enabled && !forceEncrypted) return { content, encrypted: false };
    if (!c) throw new Error("This chat's key is missing. Editing was blocked.");
    checkId(authorId);
    if (!c.keys[c.current]) throw new Error("This chat's key is missing. Sending was blocked.");
    // Empty captions contain no data. Leave file-only sends file-only instead
    // of attaching an authenticated but unnecessary empty-text envelope.
    if (content === "") return { content: "", encrypted: true };
    const wireToken = `${channelId}:${authorId}:${content}`;
    if (issuedEnvelopes.has(wireToken) && content.length <= maxLength) return { content, encrypted: true };
    // A second guard may see an envelope already produced by the composer guard.
    if (content.startsWith(TEXT_PREFIX)) {
        try {
            decryptText(content, c.keys, channelId, authorId);
            if (content.length <= maxLength) return { content, encrypted: true };
        } catch { /* User-entered or modified envelope: encrypt as ordinary text. */ }
    }
    const encrypted = encryptText(content, c.keys[c.current], channelId, authorId);
    if (encrypted.length > maxLength) throw new Error(`Encrypted text exceeds Discord's ${maxLength}-character limit. Shorten it or encrypt it as a file.`);
    if (issuedEnvelopes.size >= 256) issuedEnvelopes.delete(issuedEnvelopes.values().next().value!);
    issuedEnvelopes.add(`${channelId}:${authorId}:${encrypted}`);
    return { content: encrypted, encrypted: true };
}

export function decryptMessage(_: IpcMainInvokeEvent, channelId: string, authorId: string, content: string) {
    const c = config(channelId);
    if (!c) throw new Error("Set this chat's shared key using the lock button.");
    return decryptText(content, c.keys, channelId, authorId);
}

export function verifyUpload(_: IpcMainInvokeEvent, channelId: string, bytes: Uint8Array): boolean {
    const c = config(channelId);
    if (!c?.enabled) return true;
    decryptFile(Buffer.from(bytes), c.keys, channelId);
    return true;
}

export function encryptUpload(_: IpcMainInvokeEvent, channelId: string, bytes: Uint8Array, filename: string): Uint8Array {
    const c = config(channelId);
    if (!c?.enabled) throw new Error("Encryption changed during this upload. Please attach the file again.");
    const data = Buffer.from(bytes);
    // Recognize already-encrypted copies by authentication, not their extension.
    try { decryptFile(data, c.keys, channelId); return new Uint8Array(data); }
    catch { return new Uint8Array(encryptFile(data, filename, c.keys[c.current], channelId)); }
}

function windowFor(e: IpcMainInvokeEvent): BrowserWindow {
    const window = BrowserWindow.fromWebContents(e.sender);
    if (!window) throw new Error("Cannot open a file dialog for this window.");
    return window;
}

export async function decryptAttachment(_: IpcMainInvokeEvent, channelId: string, url: string) {
    const encrypted = await downloadEncrypted(channelId, url);
    if (!encrypted.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) return { encrypted: false as const };
    const c = config(channelId);
    if (!c) throw new Error("Set this chat's shared key to view its attachments.");
    const file = decryptFile(encrypted, c.keys, channelId);
    return { encrypted: true as const, filename: file.filename, mime: mediaType(file.data, file.filename), data: new Uint8Array(file.data) };
}

export async function downloadEncryptedAttachment(e: IpcMainInvokeEvent, channelId: string, url: string, filename: string) {
    attachmentUrl(channelId, url);
    filename = String(filename).split(/[\\/]/).pop()!.replace(/[\x00-\x1f<>:"|?*]/g, "_").slice(0, 230) || "encrypted.vcs";
    if (!filename.toLowerCase().endsWith(".vcs")) filename += ".vcs";
    const destination = await dialog.showSaveDialog(windowFor(e), {
        title: "Save encrypted file", defaultPath: filename, filters: [{ name: "SharedKey encrypted files", extensions: ["vcs"] }]
    });
    if (destination.canceled || !destination.filePath) return false;
    await streamEncryptedToDisk(channelId, url, destination.filePath);
    return true;
}

export async function saveDecryptedAttachment(e: IpcMainInvokeEvent, filename: string, bytes: Uint8Array) {
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("File exceeds the 64 MiB limit.");
    filename = String(filename).split(/[\\/]/).pop()!.replace(/[\x00-\x1f<>:"|?*]/g, "_").slice(0, 240) || "decrypted-file";
    const destination = await dialog.showSaveDialog(windowFor(e), { title: "Save file", defaultPath: filename });
    if (destination.canceled || !destination.filePath) return false;
    await writeFile(destination.filePath, bytes, { mode: 0o600 });
    return true;
}

export async function fileTool(e: IpcMainInvokeEvent, channelId: string, decrypt: boolean) {
    const c = config(channelId);
    if (!c?.keys[c.current]) throw new Error("Save a shared key for this chat first.");
    const window = windowFor(e);
    const selection = await dialog.showOpenDialog(window, {
        title: decrypt ? "Select a downloaded encrypted .vcs file" : "Select a file to encrypt locally",
        properties: ["openFile"],
        ...(decrypt ? { filters: [{ name: "SharedKey encrypted files", extensions: ["vcs"] }] } : {})
    });
    if (selection.canceled || !selection.filePaths[0]) return "Cancelled.";
    const inputPath = selection.filePaths[0];
    if ((await stat(inputPath)).size > MAX_FILE_BYTES + (decrypt ? 4200 : 0)) throw new Error("File exceeds the 64 MiB limit.");
    const input = await readFile(inputPath);
    const output = decrypt
        ? decryptFile(input, c.keys, channelId)
        : { filename: "encrypted.vcs", data: encryptFile(input, basename(inputPath), c.keys[c.current], channelId) };
    const destination = await dialog.showSaveDialog(window, {
        title: decrypt ? "Save decrypted file" : "Save encrypted file, then attach this copy",
        defaultPath: output.filename,
        ...(decrypt ? {} : { filters: [{ name: "SharedKey encrypted files", extensions: ["vcs"] }] })
    });
    if (destination.canceled || !destination.filePath) return "Cancelled.";
    if (destination.filePath.toLowerCase() === inputPath.toLowerCase()) throw new Error("Choose a different filename to preserve the original.");
    await writeFile(destination.filePath, output.data, { mode: 0o600 });
    return decrypt ? `Decrypted file saved to ${destination.filePath}` : `Encrypted file saved to ${destination.filePath}. Attach that .vcs copy to this chat.`;
}
