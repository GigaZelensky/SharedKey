/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Message } from "@vencord/discord-types";
import { ReferencedMessageStore, useEffect, useLayoutEffect, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";

import { EditedMarker } from "./EditedMarker";
import { clearAttachmentCache, encryptedAttachments, EncryptedFiles, hideEncryptedOriginals, onAttachmentReady } from "./FileAttachments";
import { PlaintextWithPreviews, previewLinks } from "./LinkPreviews";
import { mentionsUser } from "./localMentions";
import { messageTint } from "./MessageColors";
import { joinMessageRun } from "./MessageRuns";
import { SharedKeyNative } from "./Options";

const plaintext = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const colors = new Map<string, string>();
const replyViews = new WeakSet<object>();
let generation = 0;

export function clearMessageCache() { generation++; plaintext.clear(); pending.clear(); colors.clear(); clearAttachmentCache(); }

export function rememberPlaintext(channelId: string, authorId: string, content: string, text: string) {
    if (plaintext.size >= 500) plaintext.delete(plaintext.keys().next().value!);
    plaintext.set(`${channelId}:${authorId}:${content}`, text);
}

export function cachedPlaintext(message: Message) { return plaintext.get(`${message.channel_id}:${message.author.id}:${message.content}`); }
export function requestPlaintext(native: SharedKeyNative, message: Message) { return decrypt(native, message, `${message.channel_id}:${message.author.id}:${message.content}`); }
export function markReplyView(message: Message) { replyViews.add(message); }

export function imagePreviews(text: string): string[] { return previewLinks(text).filter(link => !link.page).map(link => link.url); }

function decrypt(native: SharedKeyNative, message: Message, token: string): Promise<string> {
    if (plaintext.has(token)) return Promise.resolve(plaintext.get(token)!);
    let request = pending.get(token);
    if (!request) {
        const currentGeneration = generation;
        request = native.decryptMessage(message.channel_id, message.author.id, message.content).then(text => {
            if (currentGeneration === generation) {
                if (plaintext.size >= 500) plaintext.delete(plaintext.keys().next().value!);
                plaintext.set(token, text);
            }
            return text;
        });
        pending.set(token, request);
        const complete = () => { if (pending.get(token) === request) pending.delete(token); };
        void request.then(complete, complete);
    }
    return request;
}

export function EncryptedBody({ message, native, version }: { message: Message; native: SharedKeyNative; version: number; }) {
    const [, refreshFiles] = useState(0);
    useEffect(() => onAttachmentReady(() => refreshFiles(v => v + 1)), []);
    const token = `${message.channel_id}:${message.author.id}:${message.content}`;
    const encrypted = message.content?.startsWith("[VCS1:");
    const attachmentIds = encryptedAttachments(message).map(file => file.id).join(":");
    const protectedMessage = encrypted || !!attachmentIds;
    const reference = useStateFromStores([ReferencedMessageStore], () => message.messageReference ? ReferencedMessageStore.getMessageByReference(message.messageReference) : undefined);
    const referenced = reference?.message;
    const protectedReply = !!referenced && (replyViews.has(referenced) || referenced.content?.startsWith("[VCS1:") || encryptedAttachments(referenced).length > 0);
    const [result, setResult] = useState<{ token: string; text?: string; error?: string; }>(() => ({ token, text: plaintext.get(token) }));
    const text = plaintext.get(token) ?? (result.token === token ? result.text : undefined);
    const userId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    const localMention = encrypted && !message.mentioned && mentionsUser(text, userId);
    const [color, setColor] = useState(colors.get(message.channel_id) ?? "#7d52ff");
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!protectedMessage && !protectedReply) return;
        let live = true;
        if (encrypted) void decrypt(native, message, token)
            .then(text => { if (live) setResult({ token, text }); })
            .catch(() => { if (live) setResult({ token, error: "Unable to decrypt. Check this chat's shared key." }); });
        void native.channelInfo(message.channel_id).then(info => {
            colors.set(message.channel_id, info.color);
            if (live) setColor(info.color);
        }).catch(() => {});
        return () => { live = false; };
    }, [token, attachmentIds, protectedReply, version]);

    useLayoutEffect(() => {
        const row = ref.current?.closest("li") as HTMLElement | null;
        // Confirmation dialogs render the same message inside a div, without
        // a chat-list li. Scope replacement to that message in either surface.
        const surface = ref.current?.closest<HTMLElement>('[class*="message_"]') ?? row;
        if (!surface || (!protectedMessage && !protectedReply)) return;
        surface.classList.add("vc-sharedkey-surface");
        if (row && protectedMessage) {
            row.classList.add("vc-sharedkey-row");
            row.classList.toggle("vc-sharedkey-mentioned", localMention);
            row.dataset.sharedkeyChannel = message.channel_id;
            row.style.setProperty("--vc-sharedkey-color", color);
            row.style.setProperty("--vc-sharedkey-fill", messageTint(color, 0.14));
            row.style.setProperty("--vc-sharedkey-hover", messageTint(color, 0.105));
        }
        const reply = surface.querySelector<HTMLElement>('[class*="repliedMessage"]');
        if (reply && protectedReply) {
            reply.classList.add("vc-sharedkey-reply-row");
            reply.style.setProperty("--vc-sharedkey-fill", messageTint(color, 0.14));
            reply.style.setProperty("--vc-sharedkey-hover", messageTint(color, 0.105));
        }
        const restoreRun = row && protectedMessage ? joinMessageRun(row) : () => {};
        const restoreFileCards = hideEncryptedOriginals(surface, message);
        return () => {
            restoreFileCards();
            surface.classList.remove("vc-sharedkey-surface");
            if (reply && protectedReply) { reply.classList.remove("vc-sharedkey-reply-row"); reply.style.removeProperty("--vc-sharedkey-fill"); reply.style.removeProperty("--vc-sharedkey-hover"); }
            row?.classList.remove("vc-sharedkey-row");
            row?.classList.remove("vc-sharedkey-mentioned");
            if (row) delete row.dataset.sharedkeyChannel;
            restoreRun();
            for (const property of ["--vc-sharedkey-color", "--vc-sharedkey-fill", "--vc-sharedkey-hover"]) row?.style.removeProperty(property);
        };
    }, [message.id, token, protectedMessage, protectedReply, attachmentIds, color, localMention]);

    if (!protectedMessage && !protectedReply) return null;
    return (
        <div ref={ref} className={encrypted ? "vc-sharedkey-message" : attachmentIds ? "vc-sharedkey-attachments-only" : "vc-sharedkey-reply-anchor"}>
            {encrypted && (text !== undefined ? text ? <PlaintextWithPreviews text={text} channelId={message.channel_id} messageId={message.id} native={native} editedTimestamp={message.editedTimestamp} /> : <EditedMarker timestamp={message.editedTimestamp} /> : result.token === token && result.error
                ? <><span className="vc-sharedkey-error">{result.error}</span><EditedMarker timestamp={message.editedTimestamp} /></>
                : <span className="vc-sharedkey-pending" aria-label="Decrypting encrypted message" />)}
            <EncryptedFiles message={message} native={native} version={version} />
        </div>
    );
}
