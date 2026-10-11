import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromeExecutable } from "./browser.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(root + "/.test-output", { recursive: true });
const require = createRequire(root + "/package.json");
const { build } = require("esbuild"),
    puppeteer = require("puppeteer-core");
await build({
    entryPoints: [root + "/src/MessageRuns.ts"],
    bundle: true,
    format: "iife",
    globalName: "runs",
    outfile: root + "/.test-output/message-runs-test.js",
});
const js = await readFile(root + "/.test-output/message-runs-test.js", "utf8"),
    css = await readFile(root + "/src/style.css", "utf8");
const browser = await puppeteer.launch({
    executablePath: chromeExecutable(),
    headless: true,
    userDataDir: root + "/.test-output/seams-profile",
    args: ["--no-first-run", ...(process.env.CI ? ["--no-sandbox"] : [])],
});
let checked = 0,
    oldSeams = 0;
try {
    const page = await browser.newPage();
    await page.mouse.move(590, 590);
    for (const dpr of [1, 1.25, 1.5, 2]) {
        await page.setViewport({ width: 600, height: 600, deviceScaleFactor: dpr });
        await page.setContent(
            `<style>body{margin:0;background:black}ol{padding:0;margin:0;list-style:none}li{--vc-sharedkey-color:#7d52ff;--vc-sharedkey-fill:rgba(125,82,255,.14);--vc-sharedkey-hover:rgba(125,82,255,.105)}</style><style>${css}</style><style id=legacy>.legacy .vc-sharedkey-row::after{display:none}.legacy .vc-sharedkey-row{box-shadow:0 calc(-1 * var(--vc-sharedkey-gap,0px)) 0 0 var(--vc-sharedkey-fill)}</style><ol id=list></ol><script>${js}</script>`,
        );
        for (const background of ["rgb(0,0,0)", "rgb(24,26,33)", "rgb(240,242,248)"])
            for (const offset of [0, 0.125, 0.25, 0.5, 0.75])
                for (const margin of [0, 16, 24]) {
                    const geometry = await page.evaluate(
                        async ({ background, offset, margin }) => {
                            window.cleanup?.forEach((fn) => fn());
                            document.body.style.background = background;
                            const list = document.querySelector("#list");
                            list.style.paddingTop = offset + "px";
                            list.innerHTML = Array.from(
                                { length: 7 },
                                (_, i) =>
                                    `<li class="vc-sharedkey-row" data-sharedkey-channel="chat"><div class="message_native" style="height:${37.125 + i * 0.125}px;margin-top:${i ? margin : 0}px"><span data-marker style="position:absolute;left:20px;bottom:0;width:10px;height:3px;background:red"></span></div></li>`,
                            ).join("");
                            window.geometry = () => ({
                                height: document.documentElement.scrollHeight,
                                scroll: document.documentElement.scrollTop,
                                rows: Array.from(list.children).map((e) => {
                                    const r = e.getBoundingClientRect();
                                    return {
                                        top: r.top,
                                        height: r.height,
                                        margin: getComputedStyle(e).marginTop,
                                        padding: getComputedStyle(e).paddingTop,
                                    };
                                }),
                            });
                            const before = window.geometry();
                            window.cleanup = Array.from(list.children).map(runs.joinMessageRun);
                            await new Promise(requestAnimationFrame);
                            await new Promise(requestAnimationFrame);
                            return before;
                        },
                        { background, offset, margin },
                    );
                    assert.deepEqual(
                        await page.evaluate(() => window.geometry()),
                        geometry,
                        "Painting cannot alter row or scroll geometry",
                    );
                    const scan = async () => {
                        const data = await page.screenshot({ encoding: "base64" });
                        return page.evaluate(
                            async ({ data, dpr }) => {
                                const image = new Image();
                                image.src = "data:image/png;base64," + data;
                                await image.decode();
                                const canvas = document.createElement("canvas");
                                canvas.width = image.width;
                                canvas.height = image.height;
                                const ctx = canvas.getContext("2d");
                                ctx.drawImage(image, 0, 0);
                                const read = (x, y) =>
                                    Array.from(ctx.getImageData(Math.floor(x * dpr), y, 1, 1).data);
                                const reference = read(
                                    300,
                                    Math.floor(
                                        (document.querySelector("#list").children[0].getBoundingClientRect()
                                            .top +
                                            15) *
                                            dpr,
                                    ),
                                );
                                let dark = 0,
                                    bright = 0,
                                    markers = 0;
                                const children = document.querySelector("#list").children;
                                for (let i = 1; i < children.length; i++) {
                                    const prev = children[i - 1].getBoundingClientRect(),
                                        next = children[i].getBoundingClientRect();
                                    for (
                                        let y = Math.floor(prev.bottom * dpr) - 1;
                                        y <= Math.ceil(next.top * dpr) + 1;
                                        y++
                                    ) {
                                        const pixel = read(300, y);
                                        if (pixel.slice(0, 3).some((v, j) => v < reference[j] - 2)) dark++;
                                        if (pixel.slice(0, 3).some((v, j) => v > reference[j] + 2)) bright++;
                                    }
                                    const marker = read(24, Math.floor(prev.bottom * dpr) - 2);
                                    if (marker[0] > 220 && marker[1] < 20 && marker[2] < 20) markers++;
                                }
                                return { dark, bright, markers };
                            },
                            { data, dpr },
                        );
                    };
                    const result = await scan();
                    assert.equal(result.dark, 0, JSON.stringify({ dpr, background, offset, margin, result }));
                    assert.equal(result.bright, 0, "Overlapping paint must not double the tint");
                    assert.equal(result.markers, 6, "The strip must stay behind message content");
                    if (dpr === 1.25 && background === "rgb(0,0,0)" && margin === 16) {
                        await page.evaluate(() => document.body.classList.add("legacy"));
                        oldSeams += (await scan()).dark;
                        await page.evaluate(() => document.body.classList.remove("legacy"));
                    }
                    checked++;
                }
    }
    assert.ok(oldSeams > 0, "Regression fixture reproduces the previous shadow seam");
    console.log(
        `PASS ${checked} pixel cases: fractional rows, 100/125/150/200% scaling, zero/16/24px gaps, dark/light backgrounds, no dark or doubled-tint seam, foreground preserved, unchanged scroll geometry. Old shadow reproduced ${oldSeams} dark pixels.`,
    );
} finally {
    await browser.close();
}
