import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { configuration, root, vencord } from "./paths.mjs";

const output = path.join(root, "artifacts", "SharedKey-friend-kit");
const buildFiles = [
    "patcher.js",
    "patcher.js.map",
    "patcher.js.LEGAL.txt",
    "preload.js",
    "preload.js.map",
    "renderer.js",
    "renderer.js.map",
    "renderer.js.LEGAL.txt",
    "renderer.css",
    "renderer.css.map",
];
await mkdir(path.join(output, "dist"), { recursive: true });
const files = [];
for (const name of buildFiles) {
    const bytes = await readFile(path.join(vencord, "dist", name));
    await writeFile(path.join(output, "dist", name), bytes);
    files.push({ name, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const upstreamCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: vencord, encoding: "utf8" }).trim();
if (upstreamCommit !== configuration.commit)
    throw new Error("Package against the Vencord revision in vencord.json.");
await cp(path.join(root, "src"), path.join(output, "source", configuration.pluginDirectory), {
    recursive: true,
});
for (const name of ["README.md", "LICENSE", "SECURITY.md", "decrypt-file.mjs"])
    await cp(path.join(root, name), path.join(output, name));
await cp(path.join(root, "docs"), path.join(output, "docs"), { recursive: true });
await cp(path.join(root, "scripts", "Install.ps1"), path.join(output, "Install.ps1"));
await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(
        {
            plugin: "SharedKey",
            platform: "Windows desktop",
            upstreamCommit,
            buildArgs: "pnpm build --disable-updater",
            files,
        },
        null,
        2,
    ) + "\n",
);
console.log(`Friend package: ${output}`);
console.log("Zip this folder's contents, or download the Windows build artifact from GitHub Actions.");
