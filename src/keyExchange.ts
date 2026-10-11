/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vencord SharedKey contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { constants, createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPair, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, sign, timingSafeEqual, verify } from "node:crypto";

import { checkId, generateKey, parseKey } from "./crypto";
import { EXCHANGE_PREFIX } from "./exchangeWire";

export { EXCHANGE_PREFIX } from "./exchangeWire";
const TTL = 10 * 60 * 1000;
type Kind = "offer" | "reply" | "ack" | "finish";
type Packet = [1, Kind, string, string, string, string, number, string, unknown, string];
export class IdentityChangedError extends Error {
    constructor() { super("Your friend's identity key changed. Compare identities before approving the change."); }
}
export interface ExchangeState {
    self: string;
    peer: string;
    privateIdentity: string;
    publicIdentity: string;
    peerIdentity?: string;
    verified?: boolean;
    identityChanged?: boolean;
    completed: string[];
    pending?: {
        session: string; expires: number; role: "initiator" | "responder";
        offer: string; reply?: string; ack?: string; finish?: string;
        privateTransport?: string; key?: string;
    };
}

function digest(text: string) { return createHash("sha256").update(text).digest("hex"); }
function decode(value: unknown, limit: number): Buffer {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > limit * 2) throw new Error("Invalid exchange encoding.");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length > limit || bytes.toString("base64url") !== value) throw new Error("Invalid exchange encoding.");
    return bytes;
}
function identity(value: string) {
    const key = createPublicKey({ key: decode(value, 44), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid exchange identity.");
    return key;
}
function transport(value: unknown) {
    const key = createPublicKey({ key: decode(value, 422), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072 || key.asymmetricKeyDetails?.publicExponent !== 65537n) throw new Error("Invalid RSA exchange key.");
    return key;
}

export function createExchange(self: string, peer: string): ExchangeState {
    checkId(self); checkId(peer);
    if (self === peer) throw new Error("Choose a one-to-one DM with another person.");
    const pair = generateKeyPairSync("ed25519");
    return {
        self, peer, completed: [],
        privateIdentity: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
        publicIdentity: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url")
    };
}

export function validateExchangeState(state: ExchangeState): void {
    if (!state || typeof state !== "object") throw new Error("Invalid automatic key vault.");
    checkId(state.self); checkId(state.peer);
    if (state.self === state.peer || !Array.isArray(state.completed) || state.completed.length > 32 || state.completed.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(id)) || (state.verified !== undefined && typeof state.verified !== "boolean") || (state.identityChanged !== undefined && typeof state.identityChanged !== "boolean")) throw new Error("Invalid automatic key vault.");
    const privateKey = createPrivateKey({ key: decode(state.privateIdentity, 64), format: "der", type: "pkcs8" });
    identity(state.publicIdentity);
    if (privateKey.asymmetricKeyType !== "ed25519" || createPublicKey(privateKey.export({ format: "pem", type: "pkcs8" })).export({ format: "der", type: "spki" }).toString("base64url") !== state.publicIdentity) throw new Error("Invalid automatic identity pair.");
    if (state.peerIdentity) identity(state.peerIdentity);
    const p = state.pending;
    if (p) {
        if (!["initiator", "responder"].includes(p.role) || !Number.isSafeInteger(p.expires) || !/^[A-Za-z0-9_-]{22}$/.test(p.session)
            || typeof p.offer !== "string" || [p.offer, p.reply, p.ack, p.finish].some(wire => wire !== undefined && (typeof wire !== "string" || wire.length > 2000 || !wire.startsWith(EXCHANGE_PREFIX)))) throw new Error("Invalid pending exchange.");
        if (p.key) parseKey(p.key);
        if (p.privateTransport) {
            const key = createPrivateKey({ key: decode(p.privateTransport, 1900), format: "der", type: "pkcs8" });
            if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 3072) throw new Error("Invalid pending transport key.");
        }
    }
}

function encode(state: ExchangeState, channel: string, kind: Kind, session: string, expires: number, body: unknown) {
    const fields = [1, kind, channel, state.self, state.peer, session, expires, state.publicIdentity, body];
    const signature = sign(null, Buffer.from(JSON.stringify(fields)), createPrivateKey({ key: decode(state.privateIdentity, 64), format: "der", type: "pkcs8" })).toString("base64url");
    const wire = EXCHANGE_PREFIX + Buffer.from(JSON.stringify([...fields, signature])).toString("base64url") + "]";
    if (wire.length > 2000) throw new Error("Exchange message exceeds Discord's limit.");
    return wire;
}

function packet(wire: string, channel: string, author: string, state: ExchangeState, now: number): Packet {
    if (wire.length > 2000 || !wire.startsWith(EXCHANGE_PREFIX) || !wire.endsWith("]")) throw new Error("Invalid exchange message.");
    const raw = decode(wire.slice(EXCHANGE_PREFIX.length, -1), 1490).toString("utf8");
    const p = JSON.parse(raw) as Packet;
    if (!Array.isArray(p) || p.length !== 10 || JSON.stringify(p) !== raw || p[0] !== 1 || !["offer", "reply", "ack", "finish"].includes(p[1])
        || p[2] !== channel || p[3] !== author || p[3] !== state.peer || p[4] !== state.self
        || typeof p[5] !== "string" || decode(p[5], 16).length !== 16 || !Number.isSafeInteger(p[6]) || p[6] < now || p[6] > now + TTL + 30000) throw new Error("Expired exchange or wrong chat/participants.");
    checkId(channel); checkId(author);
    if (!verify(null, Buffer.from(JSON.stringify(p.slice(0, 9))), identity(p[7]), decode(p[9], 64))) throw new Error("Exchange signature failed.");
    if (state.peerIdentity && state.peerIdentity !== p[7]) throw new IdentityChangedError();
    return p;
}

function mac(key: string, phase: string, transcript: string) {
    return createHmac("sha256", parseKey(key)).update(JSON.stringify(["VencordSharedKey-exchange", 1, phase, transcript])).digest("base64url");
}
function checkMac(key: string, phase: string, transcript: string, supplied: unknown) {
    const expected = Buffer.from(mac(key, phase, transcript), "base64url");
    const actual = decode(supplied, 32);
    if (actual.length !== 32 || !timingSafeEqual(expected, actual)) throw new Error("Exchange key confirmation failed.");
}

export async function beginExchange(state: ExchangeState, channel: string, now = Date.now()) {
    checkId(channel);
    const pair = await new Promise<{ publicKey: string; privateKey: string; }>((resolve, reject) => generateKeyPair("rsa", {
        modulusLength: 3072, publicExponent: 65537,
        publicKeyEncoding: { format: "der", type: "spki" }, privateKeyEncoding: { format: "der", type: "pkcs8" }
    }, (error, publicKey, privateKey) => error ? reject(error) : resolve({ publicKey: publicKey.toString("base64url"), privateKey: privateKey.toString("base64url") })));
    const session = randomBytes(16).toString("base64url");
    const expires = now + TTL;
    const offer = encode(state, channel, "offer", session, expires, pair.publicKey);
    return { state: { ...state, pending: { session, expires, role: "initiator" as const, offer, privateTransport: pair.privateKey } }, outgoing: offer };
}

// Pure state transitions. The main-process caller persists the returned state
// before transmitting anything, and serializes transitions for each chat.
export function receiveExchange(state: ExchangeState, channel: string, author: string, wire: string, now = Date.now()): { state: ExchangeState; outgoing?: string; key?: string; } {
    const p = packet(wire, channel, author, state, now);
    const [, kind, , , , session, expires, peerIdentity, body] = p;
    const { pending } = state;
    if (state.completed.includes(session)) {
        if (kind === "ack" && pending?.session === session && pending.finish && pending.ack === wire) return { state, outgoing: pending.finish };
        return { state };
    }
    if (kind === "offer") {
        if (pending?.session === session) return { state, outgoing: pending.role === "responder" && pending.offer === wire ? pending.reply : undefined };
        // Simultaneous starts converge on the lower Discord ID's offer.
        if (pending && !state.completed.includes(pending.session) && pending.expires >= now && (pending.role !== "initiator" || BigInt(state.self) < BigInt(state.peer))) return { state };
        const rsa = transport(body);
        const key = generateKey();
        const wrapped = publicEncrypt({ key: rsa, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: Buffer.from(digest(wire), "hex") }, parseKey(key)).toString("base64url");
        const reply = encode(state, channel, "reply", session, expires, [wrapped, digest(wire), mac(key, "reply", digest(wire))]);
        return { state: { ...state, peerIdentity, pending: { session, expires, role: "responder", offer: wire, reply, key } }, outgoing: reply };
    }
    if (!pending || pending.session !== session || pending.expires !== expires || !Array.isArray(body)) throw new Error("No matching exchange. Start a new exchange in options.");
    if (kind === "reply" && pending.role === "initiator") {
        if (pending.reply) return { state, outgoing: pending.reply === wire ? pending.ack : undefined };
        if (body.length !== 3 || body[1] !== digest(pending.offer)) throw new Error("Exchange transcript changed.");
        const raw = privateDecrypt({ key: createPrivateKey({ key: decode(pending.privateTransport, 1900), format: "der", type: "pkcs8" }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: Buffer.from(digest(pending.offer), "hex") }, decode(body[0], 384));
        const key = "vcs1_" + raw.toString("base64url");
        parseKey(key);
        checkMac(key, "reply", digest(pending.offer), body[2]);
        const ack = encode(state, channel, "ack", session, expires, [digest(wire), mac(key, "ack", digest(wire))]);
        return { state: { ...state, peerIdentity, pending: { ...pending, privateTransport: undefined, key, reply: wire, ack } }, outgoing: ack };
    }
    if (kind === "ack" && pending.role === "responder" && pending.reply && pending.key) {
        if (body.length !== 2 || body[0] !== digest(pending.reply)) throw new Error("Exchange transcript changed.");
        checkMac(pending.key, "ack", digest(pending.reply), body[1]);
        const finish = encode(state, channel, "finish", session, expires, [digest(wire), mac(pending.key, "finish", digest(wire))]);
        return { state: { ...state, completed: [...state.completed.slice(-31), session], pending: { ...pending, ack: wire, finish, key: undefined } }, outgoing: finish, key: pending.key };
    }
    if (kind === "finish" && pending.role === "initiator" && pending.ack && pending.key) {
        if (body.length !== 2 || body[0] !== digest(pending.ack)) throw new Error("Exchange transcript changed.");
        checkMac(pending.key, "finish", digest(pending.ack), body[1]);
        return { state: { ...state, completed: [...state.completed.slice(-31), session], pending: undefined }, key: pending.key };
    }
    throw new Error("Unexpected exchange step.");
}

export function exchangeFingerprint(state: ExchangeState): string {
    if (!state.peerIdentity) return "";
    return digest(JSON.stringify(["VencordSharedKey-identities", 1, ...[state.publicIdentity, state.peerIdentity].sort()]));
}
