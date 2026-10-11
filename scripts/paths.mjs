import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const configuration = JSON.parse(readFileSync(path.join(root, "vencord.json"), "utf8"));
export const vencord = path.resolve(process.env.VENCORD_PATH || path.join(root, ".vencord"));

if (
    !/^[a-zA-Z][a-zA-Z0-9_-]*(?:\.desktop)?$/.test(configuration.pluginDirectory) ||
    !/^[a-f0-9]{40}$/.test(configuration.commit) ||
    !/^\d+\.\d+\.\d+$/.test(configuration.pnpmVersion)
)
    throw new Error("Invalid build configuration.");
