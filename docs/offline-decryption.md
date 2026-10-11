# Decrypt a downloaded file

Incoming files larger than the 64 MiB preview limit remain encrypted when saved. Use `decrypt-file.mjs` to restore them without loading the whole file into memory.

You need Node.js 24 or newer, the original shared key, and the original chat ID. Find the chat ID in the encryption options under **How to share a key**.

```sh
node decrypt-file.mjs --file encrypted.vcs --channel CHAT_ID --output restored-file.zip
```

Replace `CHAT_ID` with the numeric chat ID and choose a new output filename. The script prompts for the shared key without echoing it. If you already keep a protected key file, add `--key-file key.txt`.

The script checks the AES-GCM authentication tag before publishing the output. A wrong key, different channel, or modified file causes it to fail and remove its temporary output. Existing destination files are not overwritten. The authenticated original filename is printed after success.

A generic AES tool cannot decode `.vcs` directly. SharedKey also uses a key identifier, HKDF, channel context, and encrypted filename metadata. See the [protocol specification](protocol.md).

The output filesystem must support hard links, such as NTFS or ext4. The temporary file is created beside the destination so publication stays on the same filesystem.
