# Building SharedKey

You need Git, Node.js 24 or newer, and pnpm 11.9.0. The supported package targets Windows desktop Discord.

## Prepare Vencord

From the SharedKey checkout:

```sh
npm ci
git clone https://github.com/Vendicated/Vencord.git .vencord
git -C .vencord checkout 16ec4ea838899706019e7f472e45f055070abeb1
npm install --global pnpm@11.9.0
pnpm --dir .vencord install --frozen-lockfile
```

The supported Vencord revision and pnpm version are recorded in `vencord.json`. Keep the revision in this document aligned when updating that file.

## Check and build

```sh
npm test
npm run test:browser
npm run check:vencord
npm run build
npm run package
```

The check and build commands copy `src/` into `.vencord/src/userplugins/sharedKey.desktop`. The build disables Vencord's automatic updater.

`npm run package` creates `artifacts/SharedKey-friend-kit/` with the Windows build, plugin source, installer, documentation, offline decryptor, license, and SHA-256 manifest. Zip that folder's contents to share it. GitHub Actions provide the same contents as a downloadable artifact.

For an existing Vencord checkout, set `VENCORD_PATH` to its absolute path. The scripts copy only the SharedKey plugin directory; they don't install or inject the build into Discord. Use the [official Vencord custom-plugin instructions](https://docs.vencord.dev/installing/custom-plugins/) to inject your source build.

## Install or roll back

Fully quit Discord before running a package's `Install.ps1`. The installer backs up the replaced build in its own `backups/` folder and leaves settings and the key vault alone.

To roll back, fully quit Discord, then copy the backed-up `dist/` files over `%AppData%\Vencord\dist`. Reopen Discord. Keep your existing key vault; replacing it can make older messages unreadable.
