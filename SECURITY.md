# Security notes

SharedKey encrypts message text and file contents before they leave the client. It does not change Discord's transport, account system, or metadata collection.

## Trust model

Anyone with a chat's shared key can decrypt its data and create ciphertext. Share keys through a separate private channel and compare fingerprints. The fingerprint is a short SHA-256 key identifier, not a proof of your friend's identity.

Text authentication binds data to the channel and sender ID. File authentication binds data to the channel. Sender identity still depends on Discord's account system. SharedKey does not provide forward secrecy or replay prevention. Retained keys allow old messages to remain readable, including after a key is exposed.

Discord and other observers can see participants, timestamps, ciphertext sizes, upload sizes, and reply relationships. Voice, video, screen sharing, reactions, and application commands are not encrypted by this plugin.

## Local data

Keys are stored separately from Vencord's synced settings in `settings/sharedkey-vault.bin`, protected by Electron `safeStorage`. On Windows this uses the current user's OS-protected storage. An unavailable or corrupt vault blocks guarded sends; it is not silently replaced.

Other plugins and software with access to your Discord process can read drafts, decrypted content, and keys. A compromised endpoint is outside this design's protection. Text-processing plugins that send content elsewhere can also expose plaintext.

Decrypted attachments are held in local memory and blob URLs. Saving or copying an image places plaintext in the destination file or clipboard. The offline decryptor writes a temporary plaintext file while processing; it publishes the chosen destination only after authentication succeeds. Use an output directory you control.

## Validation and updates

Tests cover authentication, context binding, upload guards, vault failures, file streaming, and DOM behavior. Mocked APIs and browser fixtures do not prove that every Discord build or plugin combination follows the guarded paths. Discord's private module interfaces can change. Check the [manual integration list](docs/maintaining.md) after updating.

This implementation has not received an independent cryptographic audit.

## Reporting a problem

Contact [GigaZelensky](https://github.com/GigaZelensky) privately for a security issue. Include the SharedKey commit, Vencord revision, Discord version, and a minimal reproduction. Do not send shared keys, decrypted private messages, or your vault file.
