# Security notes

SharedKey encrypts ordinary message text and new file uploads on its guarded send paths. It does not isolate plaintext from Discord's client code or prevent all content-derived network requests.

## Trust model

Anyone with a chat's shared key can decrypt its data and create ciphertext. In manual mode, share keys through a separate private channel and compare fingerprints. The message-key fingerprint is a short SHA-256 key identifier, not a proof of your friend's identity.

Automatic exchange is available in opted-in one-to-one DMs. It uses an ephemeral RSA-3072 key with OAEP-SHA-256 to transfer a random AES key, Ed25519 identities to sign the handshake, and HMAC-SHA-256 confirmations bound to its transcript. Messages include the chat, sender, recipient, random session identifier, and a ten-minute expiry. Private keys and pending secrets remain in the OS-protected vault. Setup is blocked until key confirmation completes; an existing automatic key remains usable during rotation.

The first peer identity is trusted on first use. Signatures do not prove that this first key belongs to the intended person. An active intermediary controlling Discord could substitute identities during an unverified first exchange. Comparing the full 256-bit identity code through an independently authenticated channel detects this substitution. A validly signed packet from a different pinned identity blocks new automatic text and uploads until the user explicitly approves replacement; this state survives a restart. Approval clears verification and requires a new comparison. Resetting a peer does not delete historical decryption keys.

Password mode accepts 1–4096 UTF-8 bytes, including whitespace, without trimming or Unicode normalization. PBKDF2-HMAC-SHA-256 derives 32 bytes using 600,000 iterations and a public, domain-separated salt unique to the channel. The password is not persisted or transmitted. The derived key is retained in the vault. An observer can test guesses offline against ciphertext or its key identifier; weak passwords remain weak despite key stretching. Share passwords confidentially and use long, unique passphrases.

Text authentication binds data to the channel and sender ID. File authentication binds data to the channel. Sender identity still depends on Discord's account system, and a holder of a chat key can construct ciphertext for another sender ID. SharedKey does not provide forward secrecy or replay prevention for ordinary messages. The setup handshake rejects expired and previously completed sessions, but it is not a ratcheting messaging protocol. Retained keys allow old messages to remain readable, including after a key is exposed.

Discord and other observers can see participants, timestamps, ciphertext sizes, upload sizes, and reply relationships. Voice, video, screen sharing, reactions, and application commands are not encrypted by this plugin.

## Local data

Reading and preview preferences are stored locally in Vencord’s IndexedDB and are not synced settings. They contain no encryption keys. Existing native viewing preferences remain defaults until overridden locally.

Keys are stored separately from Vencord's synced settings in `settings/sharedkey-vault.bin`, protected by Electron `safeStorage`. On Windows this uses the current user's OS-protected storage. An unavailable or corrupt vault blocks guarded sends; it is not silently replaced.

Other plugins and software with access to your Discord process can read drafts, decrypted content, and keys. A compromised endpoint is outside this design's protection. Text-processing plugins that send content elsewhere can also expose plaintext.

When **Decrypt received messages** is enabled, incoming events and native local message records contain decrypted text so Discord can render it normally. Disabling reading restores original wire content and attachments and stops new automatic text/file decryption in that chat, without disabling outgoing encryption. It is a display/loading control, not secure erasure: saved keys and existing local caches remain, and in-flight operations may finish. Original ciphertext is retained separately for send/edit guards and ciphertext inspection. This is not a security boundary against Discord's JavaScript, other plugins, or software running as the same OS user. Discord controls its client code and could change it to collect drafts, decrypted content, or accessible secrets. Encryption protects the server-stored message/file payloads on the checked paths; it cannot guarantee that the provider can never obtain plaintext from this client.

Linked-media previews default to **On click**, with per-chat **Automatic** and **Never** alternatives. An unapproved supported preview does not invoke SharedKey’s metadata resolver, signed-URL refresher, or media loader. Native coded-link/gift widgets are suppressed for encrypted text. Loading a preview contacts the original host, exposing the requested URL/path/query and network metadata. Discord CDN links reveal the requested resource to Discord. Refreshing an expired Discord attachment URL sends that URL to Discord's refresh API. This is separate from downloading an encrypted `.vcs` upload: a remote GIF/image link points to an already hosted resource, not an encrypted attachment. The GIF picker and explicit link/image actions also make ordinary network requests.

The guarded send options remove GIF and invite analytics metadata. Unsupported polls, components, forwarded references, scheduled sends, and other structured message fields are rejected rather than sent outside the encrypted text. Unverifiable pre-uploaded attachment descriptors are also rejected; attach the original files through the guarded uploader. Attachment-removal requests for encrypted messages retain only server attachment IDs, excluding locally decrypted filenames and blob URLs.

The known native background coded-link consumer receives ciphertext instead of decrypted content. This reduces automatic template/profile/storefront lookups from that manager; it is not a blanket network filter for every Discord component. Other native renderers, analytics, explicit user actions, and other plugins have not been exhaustively audited.

Decrypted attachments are held in local memory and blob URLs. Saving or copying an image places plaintext in the destination file or clipboard. The offline decryptor writes a temporary plaintext file while processing; it publishes the chosen destination only after authentication succeeds. Use an output directory you control.

## Validation and updates

Tests cover authentication, context binding, upload guards, vault failures, file streaming, and DOM behavior. Mocked APIs and browser fixtures do not prove that every Discord build or plugin combination follows the guarded paths. Discord's private module interfaces can change. Check the [manual integration list](docs/maintaining.md) after updating.

This implementation has not received an independent cryptographic audit. See the [2026-10-12 source review](docs/security-review-2026-10-12.md) for concrete checks, fixes, and remaining limits.

## Reporting a problem

Contact [GigaZelensky](https://github.com/GigaZelensky) privately for a security issue. Include the SharedKey commit, Vencord revision, Discord version, and a minimal reproduction. Do not send shared keys, decrypted private messages, or your vault file.
