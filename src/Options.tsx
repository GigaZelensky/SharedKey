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

export type SharedKeyNative = PluginNative<typeof import("./native")>;
interface OptionsProps {
    channelId: string;
    channelName: string;
    rootProps: RenderModalProps;
    native: SharedKeyNative;
    onUpdate(info: Awaited<ReturnType<SharedKeyNative["channelInfo"]>>): void;
    embedded?: boolean;
}

function OptionsFrame({ embedded, channelName, rootProps, children }: { embedded?: boolean; channelName: string; rootProps: RenderModalProps; children: ReactNode; }) {
    return embedded ? <>{children}</> : <Modal {...rootProps} title="Encryption" subtitle={channelName} size="sm">{children}</Modal>;
}

export function EncryptionOptions({ channelId, channelName, rootProps, native, onUpdate, embedded }: OptionsProps) {
    const [info, setInfo] = useState({ enabled: false, fingerprint: "", keyCount: 0, color: "#7d52ff" });
    const [key, setKey] = useState("");
    const [savedKey, setSavedKey] = useState("");
    const [reveal, setReveal] = useState(false);
    const [busy, setBusy] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [status, setStatus] = useState("");
    const [error, setError] = useState(false);
    const inFlight = useRef(false);
    const form = useRef<HTMLDivElement>(null);
    const dirty = key.trim() !== savedKey;

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
        Promise.all([native.channelInfo(channelId), native.revealKey(channelId)])
            .then(([nextInfo, nextKey]) => {
                if (!live) return;
                setInfo(nextInfo);
                setKey(nextKey);
                setSavedKey(nextKey);
                setLoaded(true);
            })
            .catch(e => { if (live) { setError(true); setStatus(String(e.message)); } })
            .finally(() => { if (live) setBusy(false); });
        return () => { live = false; };
    }, [channelId]);

    async function action(fn: () => Promise<void>) {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setStatus("");
        setError(false);
        try { await fn(); }
        catch (e) {
            setError(true);
            setStatus(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "Could not update encryption.");
        } finally { inFlight.current = false; setBusy(false); }
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

    async function file(decrypt: boolean) {
        const result = await native.fileTool(channelId, decrypt);
        setStatus(result.startsWith("Encrypted") ? "Encrypted copy saved. Attach it to this chat." : result.startsWith("Decrypted") ? "Decrypted file saved." : result);
    }

    return (
        <OptionsFrame rootProps={rootProps} channelName={channelName} embedded={embedded}>
            <div className="vc-sharedkey-options" ref={form}>
                <div className="vc-sharedkey-toggle-row">
                    <FormSwitch title="Encrypt messages" description="Only in this chat" hideBorder value={info.enabled}
                        disabled={busy || !loaded || !info.fingerprint}
                        onChange={enabled => action(async () => { const next = await native.setEnabled(channelId, enabled); setInfo(next); onUpdate(next); })} />
                </div>

                <div className="vc-sharedkey-key-section">
                    <div className="vc-sharedkey-label-row">
                        <label htmlFor="vc-sharedkey-input">Shared key</label>
                        <TextButton disabled={busy || !loaded} onClick={() => action(async () => { setKey(await native.newKey()); setReveal(false); })}>Generate new</TextButton>
                    </div>
                    <div className="vc-sharedkey-key-field">
                        <input id="vc-sharedkey-input" type={reveal ? "text" : "password"} value={key}
                            disabled={busy || !loaded} onChange={e => { setKey(e.target.value); setStatus(""); }}
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
                        <Button size="small" disabled={busy || !key.trim()} onClick={() => action(save)}>{info.fingerprint ? "Save key" : "Save and enable"}</Button>
                    </div>}
                </div>

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
                        <Button size="small" variant="secondary" disabled={busy || !info.fingerprint} onClick={() => action(() => file(false))}>Encrypt file…</Button>
                        <Button size="small" variant="secondary" disabled={busy || !info.fingerprint} onClick={() => action(() => file(true))}>Decrypt file…</Button>
                    </div>
                    <p className="vc-sharedkey-note">Attachments encrypt on send and decrypt automatically here.</p>
                </div>

                <details className="vc-sharedkey-help">
                    <summary>How to share a key</summary>
                    <p>Both people need SharedKey and the same key in this chat. Share the key privately, then compare fingerprints.</p>
                    <p>Received files up to 64 MiB decrypt automatically. Larger files can be saved encrypted and decrypted with the offline tool. Chat ID: <code>{channelId}</code></p>
                    <p>Calls, slash commands and Discord metadata are outside this encryption.</p>
                </details>
                {status && <p role={error ? "alert" : "status"} className={error ? "vc-sharedkey-error vc-sharedkey-status" : "vc-sharedkey-status"}>{status}</p>}
            </div>
        </OptionsFrame>
    );
}
