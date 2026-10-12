# Maintaining SharedKey

## Repository layout

| Path               | Purpose                                             |
| ------------------ | --------------------------------------------------- |
| `src/`             | Vencord userplugin source                           |
| `tests/`           | Offline verification and browser fixtures           |
| `scripts/`         | Staging, build, packaging, and Windows installation |
| `decrypt-file.mjs` | Streaming decoder for saved `.vcs` files            |
| `vencord.json`     | Supported Vencord revision                          |

Generated builds, dependency checkouts, test output, user vaults, and local backups are ignored. Never commit Discord credentials, shared keys, passwords, private identity keys, or captured Discord bundles. Only include screenshots explicitly selected for documentation.

## Update Vencord

1. Choose a Vencord commit and update `vencord.json` and `docs/building.md`.
2. Check out that revision in `.vencord` and reinstall with its frozen lockfile.
3. Run the tests, plugin ESLint check, type check, and desktop build.
4. Complete the manual checks below on the target Discord build.
5. Package the build and verify its manifest before sharing it.

The plugin calls Discord's existing file, image, and media components. It does not vendor their implementations. API mocks in tests model the boundaries; they cannot guarantee compatibility with a new private Discord interface.

`MessagePresentation.ts` intercepts incoming Flux actions, including `LOAD_MESSAGES_SUCCESS`, creates, updates, pins, mentions, search results, and conversation history. It decrypts text before delivering raw payloads to the original dispatcher and preserves receive/deletion order. `IncomingEvents.ts` traverses their envelopes and nested replies without mutating the original event.

`ReceiveMessages.ts` supplies plaintext, decrypted attachment URLs, and raw media metadata. Discord performs its ordinary raw-to-record and embed conversions. Message-store and referenced-message-store getters are untouched. Local backing records contain plaintext; `WireMessages.ts` keeps ciphertext separately for outgoing edit guards and original-message inspection. Local metadata updates preserve native edit timestamps, flags, and pinned state. A narrowly scoped converter patch permits an empty caption in these local updates, which Discord otherwise ignores.

`MessagePaint.tsx` adds the accent and attachment error/retry state. Discord renders the message and completed attachments. Link metadata and decrypted file dimensions arrive asynchronously; text history is primed before display, but media loading can still change row height.

`npm test` includes receive-boundary checks with API mocks. `npm run test:discord` additionally accepts a `DISCORD_BUNDLE` environment variable pointing to a separately obtained current Discord web bundle. It executes the actual message/embed conversion and inline-media classification functions with dependency stubs. This detects changed action names, embed contracts, and the local empty-content patch; it is not a substitute for the live checks below. Never commit or package that bundle.

## Manual integration checks

Use a test chat and non-sensitive files. Verify with another client that the stored content is ciphertext and each attachment is one encrypted `.vcs` file.

- Turn reading off and back on: verify raw text/files, reply excerpts, notifications, and removal of message paint; verify new outgoing text stays encrypted while reading is off.
- With On click, verify no supported link-preview request before pressing Load preview. Repeat with cached URLs, edited messages, Never, Automatic, and a pending GIF resolve while disabling reading.
- Toggle the lock with a left-click; open options with a right-click.
- Switch between two encrypted chats, then into an unencrypted chat. Check lock state, accent, and saved color.
- Send text, a file-only ZIP, an image/GIF, and a file with a caption. Confirm there is one visible attachment per upload.
- Check reply excerpts, editing, notifications, and the delete preview.
- Send an encrypted MP4 and WebM. Check the native inline player and media viewer, including local thumbnails, seeking, sound, and download. Unsupported or damaged video must remain saveable as a file.
- Open an image in Discord's media viewer. Copy and save it through the native menu. Clicking empty space beside it must do nothing.
- Check spoiler handling and ordinary `.vcs` files that are not encrypted.
- Download an oversized incoming file as ciphertext and restore it with the offline decoder.
- Scroll consecutive encrypted messages at 125% scaling. Watch for seams and vertical readjustments.
- Try a wrong key and modified ciphertext. No plaintext should be returned by failed authentication.
- In two updated clients, select Automatic in a DM and start from either side. Compare identity codes, confirm only setup packets cross Discord, then send text and files.
- Start simultaneously, retry after a failed send, reconnect during setup, and load history after completion. Setup must converge without repeated background sends.
- Simulate a peer reinstall. The changed identity must block automatic text/uploads until explicitly replaced; old history must remain readable.
- Use Password on both clients with matching Unicode, whitespace and capitalization. Change it on one side and confirm wrong-key failures, then restore it.
- Switch all three methods in a chat and check that each restores its own key. A method waiting for a key must block guarded sends.

## Writing

Keep the README focused on installation and daily use. Put internals and maintenance details in these docs. Describe the behavior the code implements, give concrete limits, and avoid promotional security claims. Review AI-assisted copy against the code rather than treating a polished draft as evidence of accuracy.

References: [Google's technical-writing guidance for LLMs](https://developers.google.com/tech-writing/two/llms) and [developer documentation style guide](https://developers.google.com/style/highlights).
