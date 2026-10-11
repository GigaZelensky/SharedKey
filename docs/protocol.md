# SharedKey v1 wire format

All lengths below are bytes. Multi-byte integers use big-endian encoding. Strings use UTF-8.

## Keys and context

The shared key is 32 random bytes encoded as `vcs1_` followed by 43 unpadded base64url characters. Decoders require canonical encoding. Passwords are not accepted.

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
