import { spawnSync } from "node:child_process";
import { configuration, vencord } from "./paths.mjs";
import { stage } from "./stage.mjs";

const task = process.argv[2];
if (!["check", "build"].includes(task)) throw new Error("Use check or build.");
await stage();
function run(args) {
    // cmd is required for pnpm.cmd on Windows. Arguments below are fixed, not user text.
    const executable = process.platform === "win32" ? "cmd.exe" : "pnpm";
    const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm", ...args] : args;
    const result = spawnSync(executable, commandArgs, { cwd: vencord, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
if (task === "check") {
    run(["exec", "eslint", `src/userplugins/${configuration.pluginDirectory}`]);
    run(["testTsc"]);
} else run(["build", "--disable-updater"]);
