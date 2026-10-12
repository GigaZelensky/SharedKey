/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, TextButton } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { CopyIcon, EyeIcon } from "@components/Icons";
import { PluginNative } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";
import { ReactNode } from "react";

import { EncryptionMethod } from "./exchangeWire";

export type SharedKeyNative = PluginNative<typeof import("./native")>;
type ChannelInfo = Awaited<ReturnType<SharedKeyNative["channelInfo"]>>;
interface OptionsProps {
    channelId: string;
    channelName: string;
    rootProps: RenderModalProps;
    native: SharedKeyNative;
    onUpdate(info: Awaited<ReturnType<SharedKeyNative["channelInfo"]>>): void;
    onMethod(method: EncryptionMethod): Promise<ChannelInfo>;
    onExchange(): Promise<ChannelInfo>;
    embedded?: boolean;
}

function OptionsFrame({ embedded, channelName, rootProps, children }: { embedded?: boolean; channelName: string; rootProps: RenderModalProps; children: ReactNode; }) {
    return embedded ? <>{children}</> : <Modal {...rootProps} title="Encryption" subtitle={channelName} size="sm">{children}</Modal>;
}

export function EncryptionOptions({ channelId, channelName, rootProps, native, onUpdate, onMethod, onExchange, embedded }: OptionsProps) {
    const [info, setInfo] = useState<ChannelInfo>({ enabled: false, reading: true, previews: "automatic", fingerprint: "", keyCount: 0, keyIds: [], color: "#7d52ff", method: "shared", identityFingerprint: "", identityVerified: false, identityChanged: false, exchangePending: false, exchangeExpired: false });
    const [key, setKey] = useState("");
    const [savedKey, setSavedKey] = useState("");
    const [reveal, setReveal] = useState(false);
    const [busy, setBusy] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [status, setStatus] = useState("");
    const [error, setError] = useState(false);
    const [password, setPassword] = useState("");
    const [forgetting, setForgetting] = useState(false);
    const [offlineId, setOfflineId] = useState("");
    const inFlight = useRef(false);
    const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const revision = useRef(0);
    const form = useRef<HTMLDivElement>(null);
    const dirty = key.trim() !== savedKey;
    const selectedOfflineId = info.keyIds.includes(offlineId) ? offlineId : info.fingerprint || info.keyIds[0] || "";

    useEffect(() => () => clearTimeout(busyTimer.current), []);

    useLayoutEffect(() => {
        const node = form.current;
        const modal = node?.closest('[role="dialog"], [role="alertdialog"]');
        if (!node || !modal) return;
        const align = () => {
            const outer = modal.getBoundingClientRect();
            const inner = node.getBoundingClientRect();
            const difference = (inner.left - outer.left) - (outer.right - inner.right);
            node.style.paddingRight = `${Math.max(0, difference)}px`;
            node.style.paddingLeft = `${Math.max(0, -difference)}px`;
        };
        align();
        const observer = new ResizeObserver(align);
        observer.observe(modal);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        let live = true;
        native.channelInfo(channelId).then(async nextInfo => [nextInfo, nextInfo.method === "shared" ? await native.revealKey(channelId) : ""] as const)
            .then(([nextInfo, nextKey]) => {
                if (!live) return;
                setInfo(nextInfo);
                onUpdate(nextInfo);
                setKey(nextKey);
                setSavedKey(nextKey);
                setLoaded(true);
            })
            .catch(e => { if (live) { setError(true); setStatus(String(e.message)); } })
            .finally(() => { if (live) setBusy(false); });
        return () => { live = false; };
    }, [channelId]);

    useEffect(() => {
        if (!loaded) return;
        let live = true;
        const sync = () => {
            if (inFlight.current) return;
            const started = revision.current;
            const current = () => live && !inFlight.current && started === revision.current;
            void native.channelInfo(channelId).then(async next => {
                if (!current() || JSON.stringify(next) === JSON.stringify(info)) return;
                if (next.method === "shared" && (next.fingerprint !== info.fingerprint || next.method !== info.method)) {
                    const nextKey = next.fingerprint ? await native.revealKey(channelId) : "";
                    if (!current()) return;
                    setSavedKey(nextKey);
                    if (!dirty) { setKey(nextKey); setReveal(false); }
                }
                if (current()) { setInfo(next); onUpdate(next); }
            }).catch(() => {});
        };
        const timer = setInterval(sync, 1500);
        window.addEventListener("focus", sync);
        return () => { live = false; clearInterval(timer); window.removeEventListener("focus", sync); };
    }, [channelId, info, loaded, dirty]);

    async function action(fn: () => Promise<void>) {
        if (inFlight.current) return;
        inFlight.current = true;
        revision.current++;
        // Block overlapping writes immediately, but don't flash every control's
        // disabled appearance for an ordinary local save. Show it only if the
        // operation takes long enough to need visible progress feedback.
        busyTimer.current = setTimeout(() => setBusy(true), 200);
        setStatus("");
        setError(false);
        try { await fn(); }
        catch (e) {
            setError(true);
            setStatus(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "Could not update encryption.");
        } finally { clearTimeout(busyTimer.current); inFlight.current = false; setBusy(false); }
    }

    async function save() {
        const nextKey = key.trim();
        const nextInfo = await native.saveKey(channelId, nextKey);
        setInfo(nextInfo);
        setKey(nextKey);
        setSavedKey(nextKey);
        setReveal(false);
        onUpdate(nextInfo);
        setStatus("Key saved.");
    }

    async function method(value: EncryptionMethod) {
        const next = await onMethod(value);
        setInfo(next); onUpdate(next);
        const nextKey = value === "shared" ? await native.revealKey(channelId) : "";
        setKey(nextKey); setSavedKey(nextKey); setPassword(""); setReveal(false); setForgetting(false);
    }

    async function file(decrypt: boolean) {
        const result = await native.fileTool(channelId, decrypt);
        setStatus(result.startsWith("Encrypted") ? "Encrypted copy saved. Attach it to this chat." : result.startsWith("Decrypted") ? "Decrypted file saved." : result);
    }

    return (
        <OptionsFrame rootProps={rootProps} channelName={channelName} embedded={embedded}>
            <div className="vc-sharedkey-options" ref={form}>
                {!loaded && !error && <p role="status" className="vc-sharedkey-status">Loading encryption settings…</p>}
                {status && <p role={error ? "alert" : "status"} className={error ? "vc-sharedkey-error vc-sharedkey-status" : "vc-sharedkey-status"}>{status}</p>}
                <div className="vc-sharedkey-toggle-row">
                    <FormSwitch title="Encrypt outgoing messages" description="New messages and uploads in this chat" hideBorder value={info.enabled}
                        disabled={busy || !loaded}
                        onChange={enabled => action(async () => { const next = await native.setEnabled(channelId, enabled); setInfo(next); onUpdate(next); })} />
                </div>

                <div className="vc-sharedkey-toggle-row">
                    <FormSwitch title="Decrypt received messages" description="Turn off to show original ciphertext and encrypted files." hideBorder value={info.reading}
                        disabled={busy || !loaded} onChange={reading => action(async () => { const next = await native.setReadingOptions(channelId, reading, info.previews); setInfo(next); onUpdate(next); })} />
                </div>
                <div className="vc-sharedkey-method">
                    <label htmlFor="vc-sharedkey-previews">Link previews</label>
                    <select id="vc-sharedkey-previews" value={info.previews} disabled={busy || !loaded}
                        onChange={e => { const previews = e.target.value as ChannelInfo["previews"]; void action(async () => { const next = await native.setReadingOptions(channelId, info.reading, previews); setInfo(next); onUpdate(next); }); }}>
                        <option value="manual">On click</option><option value="automatic">Automatic</option><option value="never">Never</option>
                    </select>
                </div>
                <p className="vc-sharedkey-preview-note">Loading a preview contacts its host. Discord links may contact Discord. This does not make requests anonymous.</p>

                <div className="vc-sharedkey-method">
                    <label htmlFor="vc-sharedkey-method">Key setup</label>
                    <select id="vc-sharedkey-method" value={info.method} disabled={busy || !loaded}
                        onChange={e => { const value = e.target.value as EncryptionMethod; void action(() => method(value)); }}>
                        <option value="automatic">Automatic</option>
                        <option value="shared">Shared key</option>
                        <option value="password">Password</option>
                    </select>
                </div>

                {info.method === "shared" && <div className="vc-sharedkey-key-section">
                    <div className="vc-sharedkey-label-row">
                        <label htmlFor="vc-sharedkey-input">Shared key</label>
                        <TextButton disabled={busy || !loaded} onClick={() => action(async () => { setKey(await native.newKey()); setReveal(false); })}>Generate new</TextButton>
                    </div>
                    <div className="vc-sharedkey-key-field">
                        <input id="vc-sharedkey-input" type={reveal ? "text" : "password"} value={key}
                            disabled={busy || !loaded} onChange={e => { revision.current++; setKey(e.target.value); setStatus(""); }}
                            placeholder="Paste a shared key" spellCheck={false} autoComplete="off" aria-describedby="vc-sharedkey-key-note" />
                        <button type="button" className="vc-sharedkey-icon-button" title={reveal ? "Hide key" : "Show key"}
                            aria-label={reveal ? "Hide key" : "Show key"} aria-pressed={reveal} disabled={busy || !key}
                            onClick={() => setReveal(v => !v)}><EyeIcon width={18} height={18} /></button>
                        <button type="button" className="vc-sharedkey-icon-button" title="Copy key" aria-label="Copy key" disabled={busy || !key}
                            onClick={() => action(async () => { await navigator.clipboard.writeText(key.trim()); setStatus("Key copied."); })}><CopyIcon width={18} height={18} /></button>
                    </div>
                    {info.fingerprint && !dirty
                        ? <div className="vc-sharedkey-fingerprint" id="vc-sharedkey-key-note"><span>Fingerprint</span><code>{info.fingerprint.match(/.{1,4}/g)?.join(" ")}</code></div>
                        : <p className="vc-sharedkey-note" id="vc-sharedkey-key-note">{dirty ? "Save this key to use it in this chat." : "Paste your friend's key, or generate one to share."}</p>}
                    {dirty && <div className="vc-sharedkey-save-row">
                        <TextButton disabled={busy} onClick={() => { setKey(savedKey); setReveal(false); setStatus(""); }}>Cancel</TextButton>
                        <Button size="small" disabled={busy || !key.trim()} onClick={() => action(save)}>Save key</Button>
                    </div>}
                </div>}

                {info.method === "password" && <div className="vc-sharedkey-key-section">
                    <div className="vc-sharedkey-label-row"><label htmlFor="vc-sharedkey-password">Password</label></div>
                    <div className="vc-sharedkey-key-field">
                        <input id="vc-sharedkey-password" type={reveal ? "text" : "password"} value={password} disabled={busy || !loaded}
                            onChange={e => setPassword(e.target.value)} placeholder={info.fingerprint ? "Enter a new password" : "Enter the same password as your friend"} spellCheck={false} autoComplete="new-password" />
                        <button type="button" className="vc-sharedkey-icon-button" title={reveal ? "Hide password" : "Show password"} aria-label={reveal ? "Hide password" : "Show password"} aria-pressed={reveal} disabled={busy || !password}
                            onClick={() => setReveal(v => !v)}><EyeIcon width={18} height={18} /></button>
                    </div>
                    <p className="vc-sharedkey-note">Use exactly the same text, including spaces and capitalization. Short passwords can be guessed offline.</p>
                    {info.fingerprint && <div className="vc-sharedkey-fingerprint"><span>Fingerprint</span><code>{info.fingerprint.match(/.{1,4}/g)?.join(" ")}</code></div>}
                    <div className="vc-sharedkey-save-row"><Button size="small" disabled={busy || !password.length} onClick={() => action(async () => {
                        const next = await native.savePassword(channelId, password);
                        setInfo(next); onUpdate(next); setPassword(""); setReveal(false); setStatus("Password key saved.");
                    })}>Save password</Button></div>
                </div>}

                {info.method === "automatic" && <div className="vc-sharedkey-key-section">
                    <p className={info.identityChanged ? "vc-sharedkey-error" : undefined}>{info.identityChanged ? "Your friend's identity changed. Approve a replacement below to resume automatic encryption." : info.exchangePending ? "Waiting for your friend…" : info.fingerprint ? "Key exchange complete." : info.exchangeExpired ? "Setup expired. Start again." : "Both people must select Automatic in this DM."}</p>
                    {!info.fingerprint && info.enabled && <p className="vc-sharedkey-note">Messages and uploads are blocked until setup finishes.</p>}
                    <div className="vc-sharedkey-save-row"><Button size="small" disabled={busy || !loaded || !info.enabled || info.identityChanged} onClick={() => action(async () => {
                        const next = await onExchange(); setInfo(next); onUpdate(next);
                    })}>{info.exchangePending ? "Retry exchange" : info.fingerprint ? "Exchange a new key" : "Start exchange"}</Button></div>
                    {info.identityFingerprint && <>
                        <label className="vc-sharedkey-section-label">Identity code</label>
                        <code className="vc-sharedkey-identity">{info.identityFingerprint.match(/.{1,4}/g)?.join(" ")}</code>
                        <p className="vc-sharedkey-note">Compare this code with your friend in person or through another trusted channel.</p>
                        <div className="vc-sharedkey-save-row"><TextButton disabled={busy || info.identityVerified || info.identityChanged} onClick={() => action(async () => {
                            const next = await native.verifyIdentity(channelId, info.identityFingerprint); setInfo(next); onUpdate(next);
                        })}>{info.identityVerified ? "Identity compared" : "Mark as compared"}</TextButton></div>
                    </>}
                    <details className="vc-sharedkey-help"><summary>Friend reinstalled or changed identity?</summary>
                        <p>Approving a replacement clears the remembered identity. Verify the new code with your friend after setup.</p>
                        {forgetting ? <div className="vc-sharedkey-save-row">
                            <TextButton onClick={() => setForgetting(false)} disabled={busy}>Cancel</TextButton>
                            <Button size="small" disabled={busy} onClick={() => action(async () => {
                                const next = await native.forgetPeerIdentity(channelId); setInfo(next); onUpdate(next); setForgetting(false); setStatus("Previous identity cleared. Start a new exchange.");
                            })}>Approve replacement</Button>
                        </div> : <div className="vc-sharedkey-save-row"><TextButton disabled={busy} onClick={() => setForgetting(true)}>Replace remembered identity…</TextButton></div>}
                    </details>
                </div>}

                <div className="vc-sharedkey-appearance-row">
                    <label htmlFor="vc-sharedkey-color">Message color</label>
                    <div className="vc-sharedkey-color-actions">
                        <input id="vc-sharedkey-color" type="color" value={info.color} aria-label="Encrypted message background color" disabled={busy || !info.fingerprint}
                            onChange={e => { const color = e.target.value; void action(async () => { const next = await native.setColor(channelId, color); setInfo(next); onUpdate(next); }); }} />
                        <TextButton disabled={busy || !info.fingerprint || info.color === "#7d52ff"} onClick={() => action(async () => { const next = await native.setColor(channelId, "#7d52ff"); setInfo(next); onUpdate(next); })}>Reset</TextButton>
                    </div>
                </div>
                <div className="vc-sharedkey-file-section">
                    <span className="vc-sharedkey-section-label">Files</span>
                    <div className="vc-sharedkey-file-actions">
                        <Button size="small" variant="secondary" disabled={busy || !info.fingerprint || (info.method === "automatic" && info.identityChanged)} onClick={() => action(() => file(false))}>Encrypt file…</Button>
                        <Button size="small" variant="secondary" disabled={busy || !info.keyCount} onClick={() => action(() => file(true))}>Decrypt file…</Button>
                    </div>
                    <p className="vc-sharedkey-note">Attachments encrypt when sending is enabled and decrypt when reading is enabled.</p>
                </div>

                <details className="vc-sharedkey-help">
                    <summary>Setup and decryption</summary>
                    <p>{info.method === "automatic" ? "Automatic setup exchanges public keys and an encrypted chat key through Discord. Private keys stay on your computer. The first identity is remembered; comparing the code verifies the exchange." : info.method === "password" ? "Enter the same password on both computers. Share it through a separate private channel. The password is not saved or sent; its derived key is kept locally." : "Both people need SharedKey and the same key in this chat. Share the key privately, then compare fingerprints."}</p>
                    <p>Received files up to 64 MiB decrypt automatically. Larger files can be saved encrypted and decrypted with the offline tool. Chat ID: <code>{channelId}</code></p>
                    <p>Calls, slash commands and Discord metadata are outside this encryption.</p>
                    {!!info.keyCount && <>
                        {info.keyCount > 1 && <div className="vc-sharedkey-method vc-sharedkey-offline-key">
                            <label htmlFor="vc-sharedkey-offline-key">Decryption key</label>
                            <select id="vc-sharedkey-offline-key" value={selectedOfflineId} onChange={e => setOfflineId(e.target.value)} disabled={busy}>
                                {info.keyIds.map(id => <option key={id} value={id}>{id}{id === info.fingerprint ? " (current)" : ""}</option>)}
                            </select>
                        </div>}
                        <TextButton disabled={busy} onClick={() => action(async () => {
                            await navigator.clipboard.writeText(await native.revealKey(channelId, selectedOfflineId)); setStatus("Decryption key copied. Keep it private.");
                        })}>Copy key for offline decryption</TextButton>
                    </>}
                </details>

            </div>
        </OptionsFrame>
    );
}
