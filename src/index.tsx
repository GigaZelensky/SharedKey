/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { findGroupChildrenByChildId } from "@api/ContextMenu";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { MessageObject } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { IconComponent, OptionType, PluginNative } from "@utils/types";
import { CloudUpload, Message } from "@vencord/discord-types";
import { ChannelStore, Menu, MessageActions, MessageStore, Modal, openModal, React, SelectedChannelStore, showToast, useCallback, useEffect, useLayoutEffect, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";

import { bindComposerAccent } from "./ComposerAccent";
import { EncryptionMethod, EXCHANGE_PREFIX } from "./exchangeWire";
import { localFile, localImage, localVideoPoster, retryFailedAttachments } from "./FileAttachments";
import { installLocalImageActions } from "./LocalImageActions";
import { MessagePaint } from "./MessagePaint";
import { encryptedEdit, installMessagePresentation } from "./MessagePresentation";
import { clearMessageCache, rememberPlaintext, retryFailedMessages } from "./MessageView";
import type * as NativeTypes from "./native";
import { EncryptionOptions } from "./Options";
import { clearReadingPolicies, readingEnabled, rememberReadingPolicy } from "./ReadingPolicy";
import { withReadingPreferences } from "./ReadingPreferences";
import { refreshReceivedMessages } from "./ReceiveMessages";
import style from "./style.css?managed";
import { nativeVideoProps } from "./VideoPresentation";
import { wireMessage } from "./WireMessages";

const Native = withReadingPreferences(VencordNative.pluginHelpers.SharedKey as PluginNative<typeof NativeTypes>);
const subscribers = new Set<() => void>();
interface ChatDisplay { channelId: string; state: "on" | "off" | "loading" | "error"; color: string; }
const chatDisplays = new Map<string, ChatDisplay>();
let statesLoaded = false;
let statesGeneration = 0;
function rememberChat(channelId: string, info: { enabled: boolean; color: string; }) {
    const display: ChatDisplay = { channelId, state:info.enabled ? "on" : "off", color:info.color };
    chatDisplays.set(channelId, display);
    return display;
}
function initialChat(channelId: string): ChatDisplay {
    return chatDisplays.get(channelId) ?? { channelId, state:statesLoaded ? "off" : "loading", color:"#7d52ff" };
}
function chatUpdated(channelId: string, info: Awaited<ReturnType<typeof Native.channelInfo>>) { rememberReadingPolicy(channelId, info); rememberChat(channelId,info); refresh(); }

const refresh = () => { retryFailedMessages(); retryFailedAttachments(); refreshReceivedMessages(true); subscribers.forEach(fn => fn()); };
const errorText = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "SharedKey failed. Sending was blocked.";
let running = false;
const restorers: (() => void)[] = [];
const encryptedUploads = new WeakMap<CloudUpload, File>();
const uploadGuards = new WeakMap<CloudUpload, Promise<void>>();
const seenExchanges = new Set<string>();
const uploadModeChanged = "Encryption was turned off after this attachment was prepared. Remove it and attach it again to send without encryption.";

function assertUploadMode(upload: CloudUpload, enabled: boolean) {
    const file = upload.item?.file;
    if (!enabled && file && encryptedUploads.get(upload) === file) throw new Error(uploadModeChanged);
}

async function guardUpload(upload: CloudUpload) {
    const info = await Native.channelInfo(upload.channelId);
    assertUploadMode(upload, info.enabled);
    if (!info.enabled) return;
    if (info.identityChanged) throw new Error("Your friend's identity key changed. Approve the replacement in encryption options before uploading.");
    if (info.method && !info.fingerprint) throw new Error("Finish encryption setup in this chat before uploading.");
    const file = upload.item?.file;
    if (file && encryptedUploads.get(upload) === file) return;
    if (["STARTED", "UPLOADING", "COMPLETED"].includes(upload.status)) throw new Error("This attachment started uploading before encryption. Remove it and attach it again.");
    if (!file || file.size > 64 * 1024 * 1024 + 4200) throw new Error("Encrypted uploads must be 64 MiB or smaller.");
    const data = await Native.encryptUpload(upload.channelId, new Uint8Array(await file.arrayBuffer()), file.name);
    if (!(await Native.channelInfo(upload.channelId)).enabled) throw new Error(uploadModeChanged);
    const encryptedFile = new File([new Uint8Array(data).buffer], "encrypted.vcs", { type: "application/octet-stream" });
    upload.item = { ...upload.item, file: encryptedFile };
    (upload.item as any).imageConversionEvaluated = true;
    (upload.item as any).compressionMetadata = undefined;
    (upload as any).allowOptimization = false;
    (upload as any)._originalMd5 = null;
    upload.filename = "encrypted.vcs";
    upload.preCompressionSize = encryptedFile.size;
    upload.currentSize = encryptedFile.size;
    upload.postCompressionSize = encryptedFile.size;
    upload.contentHash = null;
    upload.clip = undefined;
    upload.durationSecs = undefined;
    upload.waveform = undefined;
    upload.description = null;
    upload.isImage = false;
    upload.isVideo = false;
    upload.isThumbnail = false;
    upload.mimeType = "application/octet-stream";
    encryptedUploads.set(upload, encryptedFile);
}

function useVersion() {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const fn = () => setVersion(v => v + 1);
        subscribers.add(fn);
        return () => { subscribers.delete(fn); };
    }, []);
    return version;
}

const LockIcon: IconComponent = ({ width = 20, height = 20, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
        <rect x="5" y="10" width="14" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" stroke="currentColor" strokeWidth="2" />
    </svg>
);

function chatName(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return "This chat";
    if (channel.name) return channel.guild_id ? "#" + channel.name : channel.name;
    const recipient = channel.recipients?.[0];
    const user = recipient ? UserStore.getUser(recipient) : undefined;
    return user?.globalName || user?.username || "This chat";
}

function openKeys(channelId: string) {
    openModal(props => <EncryptionOptions channelId={channelId} channelName={chatName(channelId)} rootProps={props} native={Native} onMethod={method => changeMethod(channelId, method)} onExchange={() => startAutomatic(channelId)} onUpdate={info => chatUpdated(channelId, info)} />);
}

function dmParticipants(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    const self = UserStore.getCurrentUser()?.id;
    if (!self || channel?.type !== 1 || channel.recipients?.length !== 1 || channel.recipients[0] === self) throw new Error("Automatic exchange is available in one-to-one DMs. Use a shared key or password in other chats.");
    return { self, peer: channel.recipients[0] };
}

async function sendExchange(channelId: string, content?: string) {
    if (!content || !running) return;
    await MessageActions.sendMessage(channelId, { content, tts: false, validNonShortcutEmojis: [], invalidEmojis: [] }, true, { allowedMentions: { parse: [], replied_user: false } });
}

async function receiveAutomatic(message: Message, historical = false) {
    if (!running || !message.content?.startsWith(EXCHANGE_PREFIX)) return;
    const { self, peer } = dmParticipants(message.channel_id);
    if (message.author.id !== peer) return;
    const token = `${message.channel_id}:${message.id}`;
    if (seenExchanges.has(token)) return;
    if (seenExchanges.size >= 500) seenExchanges.delete(seenExchanges.values().next().value!);
    seenExchanges.add(token);
    let result: Awaited<ReturnType<typeof Native.handleExchange>>;
    try { result = await Native.handleExchange(message.channel_id, self, peer, message.author.id, message.content, historical); }
    catch (e) { seenExchanges.delete(token); throw e; }
    if (result.info.method !== "automatic" || !result.info.enabled) seenExchanges.delete(token);
    if (!running) return;
    chatUpdated(message.channel_id, result.info);
    await sendExchange(message.channel_id, result.outgoing);
}

async function scanExchange(channelId: string) {
    // Recover a live handshake received before the user selected Automatic or
    // while Discord was disconnected. Older/expired packets cannot rekey.
    const messages = MessageStore.getMessages(channelId)?._array ?? [];
    for (const message of messages.slice(-50)) {
        const wire = wireMessage(message);
        if (wire.content?.startsWith(EXCHANGE_PREFIX)) {
            try { await receiveAutomatic(wire, true); }
            catch { /* Historical packets are expected to be expired. */ }
        }
    }
}

async function changeMethod(channelId: string, method: EncryptionMethod) {
    const participants = method === "automatic" ? dmParticipants(channelId) : undefined;
    const info = await Native.setMethod(channelId, method, participants?.self, participants?.peer);
    chatUpdated(channelId, info);
    if (method === "automatic") await scanExchange(channelId);
    return Native.channelInfo(channelId);
}

async function startAutomatic(channelId: string) {
    const { self, peer } = dmParticipants(channelId);
    const result = await Native.startExchange(channelId, self, peer);
    chatUpdated(channelId, result.info);
    await sendExchange(channelId, result.outgoing);
    return Native.channelInfo(channelId);
}

function CurrentChatSettings() {
    const channelId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getChannelId());
    if (!channelId) return <p>Select a chat to configure encryption.</p>;
    return <div className="vc-sharedkey-plugin-settings">
        <p className="vc-sharedkey-settings-chat">{chatName(channelId)}</p>
        <EncryptionOptions key={channelId} channelId={channelId} channelName={chatName(channelId)} rootProps={{ transitionState: 0, onClose() {} }} native={Native} onMethod={method => changeMethod(channelId, method)} onExchange={() => startAutomatic(channelId)} onUpdate={info => chatUpdated(channelId, info)} embedded />
    </div>;
}

const settings = definePluginSettings({ currentChat: { type: OptionType.COMPONENT, description: "Current chat", component: CurrentChatSettings } });

const togglingChats = new Set<string>();
export async function toggleChat(channelId: string) {
    if (togglingChats.has(channelId)) return;
    togglingChats.add(channelId);
    refresh();
    try {
        const info = await Native.toggleEnabled(channelId);
        rememberChat(channelId, info);
        if (info.needsKey) openKeys(channelId);
    } catch (e) { showToast(errorText(e)); }
    finally { togglingChats.delete(channelId); refresh(); }
}

const LockButton: ChatBarButtonFactory = ({ channel, isAnyChat }) => {
    const version = useVersion();
    const [icon, setIcon] = useState<SVGSVGElement | null>(null);
    const iconRef = useCallback((node: SVGSVGElement | null) => { setIcon(node); }, []);
    const [display, setDisplay] = useState<ChatDisplay>(() => initialChat(channel.id));
    const current = chatDisplays.get(channel.id) ?? (display.channelId === channel.id && display.state !== "loading" ? display : initialChat(channel.id));
    const { state } = current;
    const appearance = useRef({ enabled: state === "on", color: current.color });
    appearance.current = { enabled: state === "on", color: current.color };
    const binding = useRef<ReturnType<typeof bindComposerAccent> | null>(null);
    useEffect(() => {
        let live = true;
        Native.channelInfo(channel.id).then(info => {
            if (live && running) setDisplay(rememberChat(channel.id, info));
        }).catch(() => {
            if (live && running) {
                const failed: ChatDisplay = { channelId:channel.id,state:"error",color:"#7d52ff" };
                chatDisplays.set(channel.id, failed); setDisplay(failed);
            }
        });
        return () => { live = false; };
    }, [channel.id, version]);
    // A callback ref catches delayed Tooltip/ChatBarButton mounts. Keep the
    // binding while channel/state changes so an on-to-on switch never clears it.
    useLayoutEffect(() => {
        if (!icon) return;
        const next = bindComposerAccent(icon, appearance.current);
        binding.current = next;
        return () => { next.dispose(); if (binding.current === next) binding.current = null; };
    }, [icon]);
    useLayoutEffect(() => { binding.current?.update(appearance.current); }, [channel.id, state, current.color]);
    if (!isAnyChat) return null;
    const busy = togglingChats.has(channel.id) || state === "loading";
    return <ChatBarButton
        tooltip={state === "on" ? "Disable encryption" : "Enable encryption"}
        onClick={() => { if (!busy) void toggleChat(channel.id); }}
        onContextMenu={e => { e.preventDefault(); openKeys(channel.id); }}
        buttonProps={{ "aria-pressed": state === "on", "aria-disabled": busy }}
    >
        <svg ref={iconRef} width="20" height="20" viewBox="0 0 24 24" fill="none" className={`vc-sharedkey-lock vc-sharedkey-lock-${state}`} style={state === "on" ? { color: current.color } : undefined} aria-hidden="true">
            <rect x="5" y="10" width="14" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
            <path className="vc-sharedkey-shackle-closed" d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
            <path className="vc-sharedkey-shackle-open" d="M8 10V7a4 4 0 0 1 8-1" stroke="currentColor" strokeWidth="2" />
            <path d="M12 14v3" stroke="currentColor" strokeWidth="2" />
        </svg>
    </ChatBarButton>;
};

export function DecryptedMessage({ message }: { message: Message; }) {
    const version = useVersion();
    if (!readingEnabled(message.channel_id)) return <MessagePaint message={message} native={Native} version={version} />;
    if (message.content?.startsWith(EXCHANGE_PREFIX)) return <div className="vc-sharedkey-exchange"><button type="button" onClick={() => openKeys(message.channel_id)}>Encryption setup</button></div>;
    return <MessagePaint message={message} native={Native} version={version} />;
}

async function protect(channelId: string, message: MessageObject | any, options?: any, force = false) {
    const info = await Native.channelInfo(channelId);
    for (const upload of options?.attachmentsToUpload ?? []) assertUploadMode(upload, info.enabled);
    if (!info.enabled && !force) return;
    if (!message || typeof message.content !== "string") throw new Error("Unsupported message type in a protected chat.");
    if (message.sticker_ids?.length || options?.stickerIds?.length || options?.alsoForwardToChannelId || message.message_snapshots?.length || message.messageSnapshots?.length || options?.scheduledTimestamp
        || options?.messageReference?.type === 1 || message.message_reference?.type === 1
        || message.components?.length || message.poll || options?.poll || options?.activityAction || options?.sharedCustomTheme || options?.contentInventoryEntry || options?.announcementSendOptions || options?.mediaMention) {
        throw new Error("This message type contains fields SharedKey cannot encrypt. Send ordinary text or attach a file instead.");
    }
    if (options?.attachments?.length || message.attachments?.length) throw new Error("Pre-uploaded attachments cannot be verified. Remove them and attach the original files again for encryption.");
    const user = UserStore.getCurrentUser();
    if (!user) throw new Error("Cannot identify the current sender. Sending was blocked.");
    const originalText = message.content;
    const prepared = await Native.prepareOutgoing(channelId, user.id, originalText, user.premiumType === 2 ? 4000 : 2000, force);
    if (!prepared.encrypted) throw new Error("Encryption settings changed during this send. Please send again.");
    if (prepared.content !== originalText || !originalText.startsWith("[VCS1:")) rememberPlaintext(channelId, user.id, prepared.content, originalText);
    message.content = prepared.content;
    message.tts = false;
    message.validNonShortcutEmojis = [];
    message.invalidEmojis = [];
    if (options) {
        options.allowedMentions = { parse: [], replied_user: false };
        delete options.gifMetadata;
        delete options.inviteAnalyticsMetadata;
    }
    message.allowed_mentions = { parse: [], users: [], roles: [], replied_user: false };
}

export default definePlugin({
    name: "SharedKey",
    description: "Encrypt text and files per chat with automatic key exchange, shared keys, or passwords.",
    authors: [{ name: "GigaZelensky", id: 661221372097462272n }],
    enabledByDefault: true,
    settings,
    tags: ["Privacy", "Chat", "Utility"],
    dependencies: ["MessageAccessoriesAPI"],
    managedStyle: style,
    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: Message; optimistic?: boolean; }) {
            message = wireMessage(message);
            if (optimistic || !message.content?.startsWith(EXCHANGE_PREFIX) || !running) return;
            const channel = ChannelStore.getChannel(message.channel_id);
            if (channel?.type !== 1 || message.author.id === UserStore.getCurrentUser()?.id) return;
            void receiveAutomatic(message).catch(e => showToast(errorText(e)));
        },
        LOAD_MESSAGES_SUCCESS({ channelId }: { channelId: string; }) {
            if (running && ChannelStore.getChannel(channelId)?.type === 1) void scanExchange(channelId);
        }
    },
    isLocalImage: (src: string) => !!localImage(src),
    isLocalVideo: (src?: string) => !!src && localFile(src)?.mime.startsWith("video/"),
    videoPoster: (src: string) => localVideoPoster(src) ?? null,
    imageSource: (src: string) => localVideoPoster(src) ?? src,
    nativeVideoProps,
    networkMessage: wireMessage,
    blockNativeUnfurl: (message: Message) => wireMessage(message).content?.startsWith("[VCS1:"),
    patches: [{
        // This manager resolves codes extracted from message text over the
        // network. Give it the ciphertext, while native UI stores keep plaintext.
        find: '"MessageCodedLinkManager"',
        replacement: {
            match: /function (\i)\((\i)\)\{(?=\i\(\2\.content\?\?null,\2\.channel_id\))/,
            replace: "$&$2=$self.networkMessage($2);"
        }
    }, {
        find: ".edited_timestamp?new Date(",
        replacement: [{
            match: /null!=(\i)\.content&&""!==\1\.content&&/,
            replace: 'null!=$1.content&&(""!==$1.content||$1.sharedkey_local_update)&&'
        }, {
            // Native invite/gift widgets can fetch even without an embed.
            // Keep the ordinary text/link renderer, without automatic unfurls.
            match: /codedLinks:(\i\.\i\.NON_PARSED\.has\((\i)\.type\)\?\[\]:)/,
            replace: "codedLinks:$self.blockNativeUnfurl($2)?[]:$1"
        }, {
            match: /giftCodes:(?=\(0,\i\.\i\)\((\i)\))/,
            replace: "giftCodes:$self.blockNativeUnfurl($1)?[]:"
        }]
    }, {
        // Use the native image-link labels for authenticated local images too.
        find: "native-send-sms",
        replacement: {
            match: /function\((\i)\)\{(?=try\{let \i=new URL\(\1\);return"cdn.discordapp.com"===)/,
            replace: "$&if($self.isLocalImage($1))return true;"
        }
    }, {
        // Preserve local blobs when native image actions choose an original URL.
        find: ".canSaveImage(",
        replacement: {
            match: /function \i\((\i),\i,\i,\i\)\{(?=let \i=\i\.\i\.toURLSafe\(\1\))/,
            replace: "$&if($self.isLocalImage($1))return $1;"
        }
    }, {
        // Discord appends media resize/format query parameters to blob URLs,
        // which invalidates them. Keep local media URLs intact in its image loader.
        find: "ImageLoaderUtils.getSrcWithWidthAndHeight",
        replacement: { match: /if\((\i)\.startsWith\("data:image"\)/, replace: '$1=$self.imageSource($1);if($1.startsWith("blob:")||$1.startsWith("data:image")' }
    }, {
        // Repair the actual inline video wrapper too, regardless of which
        // upstream attachment layout assembled its poster URL.
        find: /forceExternal:!\(\i<=6016&&\i<=3384/,
        replacement: {
            match: /}=this\.props;(?=return\(0,\i\.jsx\)\(\i\.Ay,)/,
            replace: "}=$self.nativeVideoProps(this.props);"
        }
    }, {
        // Native media viewer poster lookup; preserve the local video source.
        find: /if\("VIDEO"===\i\.type&&null!=\i\.proxyUrl\)/,
        replacement: [{
            match: /function (\i)\((\i)\)\{(?=if\(null==\2\)return null;if\("VIDEO"===\2\.type&&null!=\2\.proxyUrl\))/,
            replace: "$&if($self.isLocalVideo($2?.proxyUrl??$2?.url))return $self.videoPoster($2.proxyUrl??$2.url);"
        }, {
            // The current viewer prefers the media item's explicit poster.
            match: /return\{\.\.\.(\i)\((\i)\),type:(?=\(0,\i\.\i\)\(\2\.filename\))/,
            replace: "return{...$1($2),poster:$self.videoPoster($2.proxy_url??$2.url)??undefined,type:"
        }]
    }, {
        // Native attachment thumbnails ordinarily append format=webp to a CDN
        // URL. Decrypted blobs instead have an independently decoded local poster.
        find: "srcUnfurledMediaItem:",
        replacement: {
            match: /if\(\i\)\{let (\i)=\i\.\i\.toURLSafe\((\i)\);if\(null==\1\)return null;\1\.searchParams\.append\("format","webp"\),(\i)=\1\.toString\(\)\}/,
            replace: "if($self.isLocalVideo($2))$3=$self.videoPoster($2);else $&"
        }
    }, {
        find: "async uploadFiles(",
        replacement: { match: /async uploadFiles\((\i)\)\{/, replace: "$&await $self.guardUploads($1);" }
    }, {
        find: "_uploadFileToCloud - responseUrl is not set",
        replacement: { match: /async upload\(\)\{/, replace: "$&await $self.guardUploads([this]);" }
    }],
    chatBarButton: { icon: LockIcon, render: LockButton },
    contextMenus: {
        message: (children, { message }: { message: Message; }) => {
            message = wireMessage(message);
            if (!readingEnabled(message.channel_id)) return;
            if (!message.content?.startsWith("[VCS1:")) return;
            const group = findGroupChildrenByChildId("copy-text", children) ?? children;
            const copyIndex = group.findIndex(item => item?.props?.id === "copy-text");
            if (copyIndex >= 0) group[copyIndex] = React.cloneElement(group[copyIndex]!, {
                action: async () => {
                    try { await navigator.clipboard.writeText(await Native.decryptMessage(message.channel_id, message.author.id, message.content)); }
                    catch (e) { showToast(errorText(e)); }
                }
            });
            group.push(<Menu.MenuItem id="vc-sharedkey-original" label="View encrypted original" action={() => openModal(props => <Modal {...props} title="Encrypted original" size="md"
                actions={[{ text: "Copy", variant: "secondary", onClick: () => { void navigator.clipboard.writeText(message.content).then(() => showToast("Ciphertext copied.")); } }]}>
                <pre className="vc-sharedkey-original">{message.content}</pre>
            </Modal>)} />);
        }
    },

    start() {
        running = true;
        const generation = ++statesGeneration;
        if (typeof Native.channelStates === "function") void Native.channelStates().then(states => {
            if (!running || generation !== statesGeneration) return;
            for (const [id, info] of Object.entries(states)) if (!chatDisplays.has(id)) { rememberReadingPolicy(id, info); rememberChat(id, info); }
            statesLoaded = true; refresh();
            const channelId = SelectedChannelStore.getChannelId();
            if (channelId && ChannelStore.getChannel(channelId)?.type === 1) void scanExchange(channelId);
        }).catch(() => {});
        restorers.push(installMessagePresentation(Native), installLocalImageActions(Native));
        addMessageAccessory("SharedKey", props => <ErrorBoundary noop><DecryptedMessage message={props.message} /></ErrorBoundary>, 0);
        // Guard the send/edit actions too, in case the composer patch is missing or
        // another plugin changes message content after the composer listener.
        for (const name of ["sendMessage", "_sendMessage", "editMessage"]) {
            const original = MessageActions[name];
            if (typeof original !== "function") {
                if (name !== "_sendMessage") throw new Error(`SharedKey cannot guard ${name}.`);
                continue;
            }
            const wrapped = async function (this: unknown, ...args: any[]) {
                if (running) {
                    const index = name === "editMessage" ? 2 : 1;
                    const optionsIndex = name === "sendMessage" ? 3 : 2;
                    const candidate = args[index];
                    const copy = candidate ? { ...candidate } : candidate;
                    const options = name === "editMessage" ? undefined : (args[optionsIndex] ? { ...args[optionsIndex] } : {});
                    try { await protect(args[0], copy, options, name === "editMessage" && encryptedEdit(args[0], args[1])); }
                    catch (e) { showToast(errorText(e)); throw e; }
                    args[index] = copy;
                    if (name !== "editMessage") args[optionsIndex] = options;
                }
                return original.apply(this, args);
            };
            MessageActions[name] = wrapped;
            restorers.push(() => { if (MessageActions[name] === wrapped) MessageActions[name] = original; });
        }
        // Attachment removal can pass locally decrypted filenames/URLs back to
        // the API. The server needs only the IDs of attachments being retained.
        const patchAttachments = MessageActions.patchMessageAttachments;
        if (typeof patchAttachments === "function") {
            const wrapped = async function (this: unknown, channelId: string, messageId: string, attachments: any[]) {
                if (encryptedEdit(channelId, messageId)) {
                    const original = MessageStore.getMessage(channelId, messageId);
                    const ids = new Set(original ? wireMessage(original).attachments?.map(file => file.id) : []);
                    if (!Array.isArray(attachments) || attachments.some(file => !ids.has(file.id))) throw new Error("Cannot verify this encrypted message's attachments.");
                    attachments = attachments.map(file => ({ id: file.id }));
                }
                return patchAttachments.call(this, channelId, messageId, attachments);
            };
            MessageActions.patchMessageAttachments = wrapped;
            restorers.push(() => { if (MessageActions.patchMessageAttachments === wrapped) MessageActions.patchMessageAttachments = patchAttachments; });
        }
    },
    stop() {
        running = false;
        statesGeneration++; statesLoaded = false; chatDisplays.clear(); seenExchanges.clear();
        removeMessageAccessory("SharedKey");
        clearMessageCache();
        restorers.splice(0).reverse().forEach(fn => fn());
        clearReadingPolicies();
        refresh();
    },
    async onBeforeMessageSend(channelId, message, options, props) {
        try {
            const info = await Native.channelInfo(channelId);
            if (info.enabled && props.hasStickers) throw new Error("Stickers are not encrypted. Sending was blocked.");
            await protect(channelId, message, options);
        } catch (e) { showToast(errorText(e)); return { cancel: true }; }
    },
    async onBeforeMessageEdit(channelId, messageId, message) {
        try { await protect(channelId, message, undefined, encryptedEdit(channelId, messageId)); }
        catch (e) { showToast(errorText(e)); return { cancel: true }; }
    },
    async guardUploads(uploads: CloudUpload[]) {
        if (!running) return;
        try {
            for (const upload of uploads) {
                let task = uploadGuards.get(upload);
                if (!task) { task = guardUpload(upload); uploadGuards.set(upload, task); }
                try { await task; } finally { if (uploadGuards.get(upload) === task) uploadGuards.delete(upload); }
            }
        } catch (e) {
            uploads.forEach(upload => upload.cancel());
            showToast(errorText(e));
            throw e;
        }
    }
});
