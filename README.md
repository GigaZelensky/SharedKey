# SharedKey

Encrypt Discord messages and files with a shared key for each chat.

SharedKey is a custom Vencord plugin for Windows desktop. Both people install it and use the same key. Discord receives encrypted text and `.vcs` files; your client decrypts them locally.

## Install

Install [Vencord for desktop](https://vencord.dev/download/) first.

Download a **SharedKey Windows** artifact from this repository's [Actions page](https://github.com/GigaZelensky/SharedKey/actions). Extract the ZIP, fully quit Discord from the system tray, then run `Install.ps1` in PowerShell. The installer checks the package hashes and backs up your current Vencord build. Reopen Discord after it finishes.

To compile your own build, follow [Building SharedKey](docs/building.md). Custom plugins require a Vencord source build; copying a plugin into an installed Discord folder won't load it.

## Set up a chat

1. Open the chat and right-click the lock beside the message box.
2. Choose **Generate new**, then save the key. Or paste a key your friend generated.
3. Share the key through a separate private channel. Compare the displayed fingerprint with your friend.
4. Left-click the lock to turn encryption on or off for this chat.

A closed, colored lock means encryption is on. The message box uses the same accent. A gray, open lock means it is off. Settings and keys are saved separately for each chat; you can also manage the current chat from SharedKey's plugin settings.

## Messages and files

Type and attach files normally. SharedKey encrypts them before upload and displays decrypted messages with your chosen background color.

Replies, edits, and desktop notifications use decrypted text. Images and GIFs use Discord's attachment components and media viewer. Right-click an image to copy or save it; click a document's filename to save it. The original filename is encrypted with the file contents.

Right-click an encrypted text message and choose **View encrypted original** to inspect its ciphertext. Turning encryption off keeps old messages readable. Replacing a key retains earlier keys for that chat.

## Limits

| Item                                             | Behavior                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Text                                             | Encryption adds length. SharedKey blocks a send that exceeds Discord's character limit. |
| Outgoing files                                   | Up to 64 MiB, within your Discord upload allowance.                                     |
| Incoming files up to 64 MiB                      | Decrypt in memory for previews and saving.                                              |
| Larger incoming files                            | Save the encrypted file, then use the [offline decryptor](docs/offline-decryption.md).  |
| Stickers, forwards, scheduled sends              | Blocked while this chat's encryption is on.                                             |
| Calls, screen sharing, reactions, slash commands | Outside SharedKey's encryption.                                                         |

Discord can still see participants, timestamps, message and file sizes, and reply relationships. Linked images and GIFs remain hosted by their original provider; previewing an encrypted link doesn't encrypt the remote resource.

SharedKey uses AES-256-GCM and random 256-bit keys. It has no independent security audit or forward secrecy. Read the [security notes](SECURITY.md) before relying on it for sensitive conversations.

## Development

```sh
npm ci
npm test
npm run test:browser
```

Browser tests require Chrome; set `CHROME_PATH` if it isn't in a standard location. See [build instructions](docs/building.md), [the wire format](docs/protocol.md), and [maintenance notes](docs/maintaining.md).

GitHub Actions run tests, lint and type-check the plugin against a pinned Vencord revision, and produce a Windows package. Builds disable Vencord's automatic updater so a standard update cannot replace the custom plugin. To update Vencord, rebuild SharedKey against the new revision.

## Credits

Created by **GigaZelensky**. Inspired by the per-chat workflow of [hmerritt's BetterDiscord Discord Encryption plugin](https://github.com/hmerritt/discord-encryption). SharedKey has its own protocol and is not compatible with that plugin.

GPL-3.0-or-later. See [LICENSE](LICENSE).
