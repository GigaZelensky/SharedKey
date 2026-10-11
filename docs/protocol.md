# SharedKey v1 wire format

All lengths below are bytes. Multi-byte integers use big-endian encoding. Strings use UTF-8.

## Keys and context

The message key is 32 bytes encoded as `vcs1_` followed by 43 unpadded base64url characters. Decoders require canonical encoding. Manual mode accepts this representation; automatic and password modes produce the same representation locally. All modes use the unchanged v1 message and file envelopes.

The key identifier is the first 8 bytes of SHA-256 of the raw key. The UI shows its 16-character lowercase hexadecimal representation.

Context is the UTF-8 serialization of this JSON array, without additional spaces:

```text
["VencordSharedKey",1,kind,channelId,authorId]
```

For text, `kind` is `"text"` and `authorId` is the sender's Discord ID. For files, `kind` is `"file"` and `authorId` is `""`. IDs are decimal strings.

HKDF-SHA-256 derives a 32-byte AES key using the shared key as input key material, the 8-byte key identifier as salt, and context as info. AES-256-GCM uses a fresh random 12-byte nonce. Its associated data is `context || keyIdentifier`; the authentication tag is 16 bytes.

## Sealed bundle

| Field              | Length   |
| ------------------ | -------- |
| Key identifier     | 8        |
| Nonce              | 12       |
| Ciphertext         | Variable |
| Authentication tag | 16       |

There is no padding beyond base64url encoding. A receiver selects a retained key by identifier and verifies the authentication tag before returning plaintext.

## Text

```text
[VCS1:<base64url sealed bundle>]
```

The plaintext is the message's UTF-8 bytes. New file-only sends leave message text empty instead of adding an envelope for an empty caption. Historical empty-text envelopes remain valid.

## Files

```text
ASCII "VCSFILE1" || sealed bundle
```

The encrypted plaintext is:

```text
uint32 metadataLength || JSON metadata || original file bytes
```

Metadata currently has one property: `{"filename":"original-name.ext"}`. Metadata is limited to 4096 bytes. The upload name is `encrypted.vcs`; the original name remains inside the encrypted payload.

File data is bound to the chat, not to a sender ID. The automatic encrypt/decrypt path limits plaintext to 64 MiB. The offline decoder uses the same format and streams larger incoming files.

## Compatibility

`crypto.ts` is the implementation used by the plugin. `decrypt-file.mjs` implements the streaming file-decoding path. Changes to derivation, associated data, or field order require a protocol version change and fixtures proving that older data remains readable.

## Password derivation v1

The password is UTF-8 encoded without trimming, case folding, or normalization. Empty strings and inputs exceeding 4096 UTF-8 bytes are rejected. The salt is:

```text
SHA256(UTF8(JSON.stringify(["VencordSharedKey-password",1,channelId])))
```

PBKDF2-HMAC-SHA-256 uses this salt, 600,000 iterations, and a 32-byte output. Encode the result as a `vcs1_` key, then use the existing HKDF and AES-GCM operations. Only the derived key is stored. Password mode does not add a password verifier or KDF parameters to messages; these parameters are fixed for this derivation version. The public channel-specific salt allows both clients to derive the same key independently. Ciphertext and its key identifier permit offline guessing.

## Automatic exchange v1

`keyExchange.ts` implements a four-flight exchange for one-to-one DMs. Both clients must opt in locally. Each chat stores a persistent Ed25519 identity pair and a pin for the peer's first identity. Starting an exchange generates an ephemeral RSA-3072 transport pair with exponent 65537. Completed transitions discard the private transport key and pending AES key; retained message keys still prevent forward secrecy.

Each control message is `[VCKX1:<base64url UTF-8 JSON array>]`, limited to 2000 characters. The array is:

```text
[1,kind,channelId,senderId,recipientId,session,expires,publicIdentity,body,signature]
```

`session` is 16 random bytes in canonical unpadded base64url. `expires` is a Unix timestamp in milliseconds, ten minutes after initiation. Receivers reject expired packets and expiries more than ten minutes plus 30 seconds ahead of their clock. `publicIdentity` is an Ed25519 SPKI DER key, base64url encoded. The signature is Ed25519 over the UTF-8 `JSON.stringify` serialization of the first nine fields. The decoder requires the entire JSON array to have the same canonical serialization. Sender IDs must match both the Discord event author and the expected DM participant. All fields are covered by the signature.

Define `H(wire)` as the lowercase hexadecimal SHA-256 digest of the exact UTF-8 control message, including its envelope. Define:

```text
MAC(key,phase,hash) = base64url(HMAC-SHA256(rawAESKey,
    UTF8(JSON.stringify(["VencordSharedKey-exchange",1,phase,hash]))))
```

| Flight | Body                                                 | Action                                                                                                                                         |
| ------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| offer  | RSA public key as SPKI DER base64url                 | Initiator publishes a fresh transport key.                                                                                                     |
| reply  | `[wrappedAESKey,H(offer),MAC(key,"reply",H(offer))]` | Responder generates a random 32-byte key and encrypts it with RSA-OAEP-SHA-256. The OAEP label is the raw 32-byte SHA-256 digest of the offer. |
| ack    | `[H(reply),MAC(key,"ack",H(reply))]`                 | Initiator decrypts, checks the confirmation, discards its private transport key, and proves receipt.                                           |
| finish | `[H(ack),MAC(key,"finish",H(ack))]`                  | Responder checks the acknowledgement and installs the key. Initiator checks the finish before installing it.                                   |

Every flight carries the same session and expiry and is signed by its sender's persistent identity. A client only processes steps matching its pending role and transcript. Vault transitions are serialized per chat and persisted before outbound packets are returned to the renderer. Duplicate live steps can resend the stored response. Completed sessions are retained in a bounded list of 32 identifiers and cannot rekey; their expiry also bounds replays after eviction. Loading completed setup history does not send another confirmation. Simultaneous initiations converge on the lower Discord user ID's offer.

The comparison code is the full lowercase hexadecimal SHA-256 of:

```text
UTF8(JSON.stringify(["VencordSharedKey-identities",1,
    ...[localPublicIdentity,peerPublicIdentity].sort()]))
```

Both sides display the same code. This authenticates the remembered identity pair when compared through a trusted channel; it does not prove first-use identity by itself. The UI's verification action is bound to the current code and fails if it changed. A validly signed packet carrying a changed pinned peer key is rejected before any exchange transition and persists a flag blocking new automatic text and uploads. Explicitly approving a replacement removes the pin, pending state, and active automatic-key selection, clears the flag and verification, and retains old message keys solely for decryption.
