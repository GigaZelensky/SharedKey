import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuration, root, vencord } from "./paths.mjs";

export async function stage() {
    const manifest = JSON.parse(await readFile(path.join(vencord, "package.json"), "utf8"));
    if (manifest.name !== "vencord") throw new Error("VENCORD_PATH must point to a Vencord source checkout.");
    const destination = path.join(vencord, "src", "userplugins", configuration.pluginDirectory);
    await mkdir(destination, { recursive: true });
    await cp(path.join(root, "src"), destination, { recursive: true });
    console.log(`Staged SharedKey: ${destination}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await stage();
