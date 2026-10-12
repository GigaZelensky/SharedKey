# Receive integration and confidentiality review

Reviewed the 0.4.0 receive rewrite and hardened the identified paths in 0.4.1. This is a source review with synthetic tests, not an independent audit or a live network capture of the installed Discord process.

## Result

The reviewed ordinary text, edit, and fresh-upload paths encrypt their payloads. No failure of the AES-GCM construction was found. However, the plugin cannot guarantee that Discord can never obtain plaintext: decryption takes place inside Discord's client, and some ordinary features make network requests derived from the decrypted content.

## Checks

- Text and file encryption use AES-256-GCM, random 12-byte nonces, 16-byte authentication tags, and HKDF-SHA-256 with separate text/file context. Authentication covers the channel and, for text, the sender ID. Decryption returns only after tag verification.
- A separate Web Crypto decoder successfully decrypted the documented text envelope. Tests reject modified data, wrong keys, and different channel/sender contexts. This supplements round-trip tests through the plugin's own decoder.
- Both public and private message-send actions encrypt before invoking the original action. Inspection of the current native sender shows that its queue payload uses the encrypted input string; the copied, decrypted receive event does not replace that variable.
- Editing a decrypted native record remains encrypted even when encryption for new messages is off. Original receive events and the separate ciphertext registry remain unchanged.
- Both upload entry points run their guards before the current native upload-URL request and file-byte transfer. Synthetic tests inspect the bytes crossing the mocked upload boundary and authenticate/decrypt them back to the original ZIP/GIF data. Original filenames are inside the encrypted file payload.
- Existing tests cover vault failures, unavailable credential storage, changed identities, incomplete key setup, key exchange confirmation and replay checks, password derivation, and authenticated streaming file decryption.

## Fixed in 0.4.1

| Finding                                                                                                                                   | Change                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The current native sender passes `allowedMentions` through as API fields, where reply suppression is `replied_user`.                      | Use the API field name to suppress remote reply pings; local reply highlighting remains available.                                                                                                                                                    |
| Native GIF send analytics can include `gif_url` outside encrypted message text.                                                           | Strip `gifMetadata` and `inviteAnalyticsMetadata` from protected send options. This does not hide searches or selections already made in the GIF picker.                                                                                              |
| Polls, components, and other structured fields can carry plaintext outside `content`.                                                     | Reject unsupported structured payloads on guarded sends/edits, including current native forward references.                                                                                                                                           |
| Pre-uploaded descriptors can bypass encryption of the underlying bytes.                                                                   | Reject them in protected sends; require fresh files through the guarded uploader.                                                                                                                                                                     |
| The native attachment-edit API accepts attachment objects, which may now contain decrypted filenames and blob URLs.                       | Send only the IDs of retained original attachments for encrypted messages; reject unknown IDs.                                                                                                                                                        |
| The native background coded-link manager reads decrypted incoming text and can resolve template/profile/storefront data over the network. | Feed that manager the original wire message. A test executes its actual entry function from the current Discord bundle, demonstrating plaintext consumption before the patch and ciphertext consumption after it. Native UI records remain decrypted. |
| Security documentation still described the removed getter-based implementation.                                                           | Correct the documentation to state that native records and incoming events contain plaintext.                                                                                                                                                         |

## Remaining limits

Automatic image/GIF previews expose the requested URL to its host. Requests for Discord CDN resources go to Discord; refreshing expired attachment links sends their URLs to Discord's refresh API. This describes 0.4.1. In 0.5.0, supported previews default to per-message click-to-load; the chat can instead select Automatic or Never. Native invite/gift widget generation is also suppressed for encrypted text. Decrypted uploaded files instead use local blob URLs after the encrypted download.

The coded-link patch covers one verified background consumer. It does not establish that every renderer, telemetry event, extension, reporting flow, search action, or explicit user action avoids content-derived requests. No exhaustive inspection of Discord's entire client or live traffic capture was performed. A no-disclosure claim would therefore be unjustified.

Discord's code, other plugins, and software with sufficient local access can read drafts or decrypted records. OS-protected key storage protects the saved vault, not a process that is authorized to decrypt it. See [Electron's safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage). A malicious client update is outside the protection this plugin provides.

Automatic exchange still requires independently comparing identity codes to authenticate first use. Password-derived keys are vulnerable to offline guessing when the password is weak. Message keys are retained for history, with no forward secrecy or ordinary-message replay prevention. These limits are unchanged by the receive rewrite.

## Reproduction

Run `npm test` for the crypto, native-handler, send/upload, and receive-boundary checks. Set `DISCORD_BUNDLE` to a separately obtained current Discord web bundle and run `npm run test:discord` for the actual converter and background-consumer contract checks. Tests use synthetic content and keys; no private chat contents or vault data are needed.

The GCM and HKDF API behavior used here is documented in [Node.js crypto](https://nodejs.org/api/crypto.html). Passing these tests does not prove absence of all leakage or compatibility with every future Discord build.
