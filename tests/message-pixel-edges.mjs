import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromeExecutable } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(root + "/package.json");
const { build } = require("esbuild"),
    puppeteer = require("puppeteer-core");
await mkdir(root + "/.test-output", { recursive: true });
await build({
    entryPoints: [root + "/src/MessageRuns.ts"],
    bundle: true,
    format: "iife",
    globalName: "runs",
    outfile: root + "/.test-output/pixel-runs.js",
});
const js = await readFile(root + "/.test-output/pixel-runs.js", "utf8"),
    css = await readFile(root + "/src/style.css", "utf8");
const browser = await puppeteer.launch({
    executablePath: chromeExecutable(),
    headless: true,
    args: process.env.CI ? ["--no-sandbox"] : [],
});
let checked = 0;
const failures = [];
try {
    const page = await browser.newPage();
    for (const dpr of [0.8, 0.9, 1, 1.1, 1.125, 1.25, 1.375, 1.5, 1.5625, 1.75, 1.875, 2, 2.5, 3]) {
        await page.setViewport({ width: 600, height: 500, deviceScaleFactor: dpr });
        for (const offset of [0, 0.125, 0.25, 0.5, 0.75])
            for (const border of [0, 1]) {
                await page.mouse.move(590, 490);
                await page.setContent(
                    `<style>body{margin:0;background:black}ol{margin:0;padding:${offset}px 0 32px;list-style:none}li{border-top:${border}px solid transparent;--vc-sharedkey-color:#7d52ff;--vc-sharedkey-accent-fill:rgba(125,82,255,.14);--vc-sharedkey-fill:rgba(125,82,255,.14);--vc-sharedkey-hover:rgba(125,82,255,.105)}.message_native{height:59.625px;margin-top:16px}#reference{position:fixed;top:450px;width:600px;height:20px;background:rgba(125,82,255,.14)}</style><style>${css}</style><ol>${[0, 1, 2].map(() => '<li class="vc-sharedkey-row" data-sharedkey-channel="chat"><div class="message_native"></div></li>').join("")}</ol><div id=reference></div><script>${js}</script>`,
                );
                const junctions = await page.evaluate(async () => {
                    [...document.querySelectorAll("li")].forEach(runs.joinMessageRun);
                    await new Promise(requestAnimationFrame);
                    await new Promise(requestAnimationFrame);
                    const bodies = [...document.querySelectorAll(".message_native")].map((e) =>
                        e.getBoundingClientRect(),
                    );
                    return [
                        bodies[0].bottom,
                        bodies[1].top,
                        bodies[1].bottom,
                        bodies[2].top,
                        bodies[2].bottom,
                    ];
                });
                const data = await page.screenshot({ encoding: "base64" });
                const bad = await page.evaluate(
                    async ({ data, dpr, junctions }) => {
                        const image = new Image();
                        image.src = "data:image/png;base64," + data;
                        await image.decode();
                        const canvas = document.createElement("canvas");
                        canvas.width = image.width;
                        canvas.height = image.height;
                        const context = canvas.getContext("2d");
                        context.drawImage(image, 0, 0);
                        const read = (y) => [...context.getImageData(Math.floor(300 * dpr), y, 1, 1).data];
                        const reference = read(Math.floor(460 * dpr));
                        return junctions.flatMap((edge) => {
                            const result = [];
                            for (let y = Math.floor(edge * dpr) - 2; y <= Math.ceil(edge * dpr) + 2; y++) {
                                const color = read(y);
                                if (color.some((v, i) => Math.abs(v - reference[i]) > 2))
                                    result.push({ edge, y, color, reference });
                            }
                            return result;
                        });
                    },
                    { data, dpr, junctions },
                );
                if (bad.length) failures.push({ dpr, offset, border, bad });
                checked++;
            }
    }
    assert.equal(
        failures.length,
        0,
        `Message paint junctions must not lose or double a pixel (${checked} cases): ${JSON.stringify(failures.slice(0, 5))}`,
    );
    console.log(
        `PASS ${checked} device-pixel edge scans across fractional row offsets, borders, and display scales`,
    );
} finally {
    await browser.close();
}
