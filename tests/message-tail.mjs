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
    outfile: root + "/.test-output/tail-runs.js",
});
const js = await readFile(root + "/.test-output/tail-runs.js", "utf8"),
    css = await readFile(root + "/src/style.css", "utf8");
const browser = await puppeteer.launch({
    executablePath: chromeExecutable(),
    headless: true,
    args: process.env.CI ? ["--no-sandbox"] : [],
});
try {
    const page = await browser.newPage();
    for (const dpr of [1, 1.25, 2]) {
        await page.setViewport({ width: 600, height: 600, deviceScaleFactor: dpr });
        for (const [footer, compact, spacing] of [
            [32, false, 16],
            [32, true, 16],
            [8, false, 24],
            [0, true, 16],
        ]) {
            await page.mouse.move(590, 590);
            await page.setContent(
                `<style>body{margin:0;background:black}#scroll{height:200px;overflow:auto}ol{padding:0;margin:0;list-style:none}li{--vc-sharedkey-color:#7d52ff;--vc-sharedkey-accent-fill:rgba(125,82,255,.14);--vc-sharedkey-fill:rgba(125,82,255,.14);--vc-sharedkey-hover:rgba(125,82,255,.105)}.message_native{height:64.25px;margin-top:${spacing}px}#last{--vc-sharedkey-fill:rgba(149,101,214,.1689);--vc-sharedkey-hover:rgba(149,101,214,.1265)}#last .message_native{margin-top:${compact ? 0 : spacing}px}#last .message_native::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:rgb(240,178,50)}#reference{position:fixed;top:500px;width:600px;height:20px;background:rgba(125,82,255,.14)}#body-reference{position:fixed;top:525px;width:600px;height:20px;background:rgba(149,101,214,.1689)}</style><style>${css}</style><div id=scroll><ol id=list>${[0, 1, 2, 3].map((i) => `<li ${i === 3 ? "id=last" : ""} class=vc-sharedkey-row data-sharedkey-channel=chat><div class=message_native></div></li>`).join("")}<div id=footer style="height:${footer}px"></div></ol></div><div id=reference></div><div id=body-reference></div><script>${js}</script>`,
            );
            const state = await page.evaluate(async () => {
                const scroll = document.querySelector("#scroll");
                scroll.scrollTop = scroll.scrollHeight;
                const geometry = () => ({
                    height: scroll.scrollHeight,
                    scroll: scroll.scrollTop,
                    list: document.querySelector("#list").getBoundingClientRect().height,
                    bodies: [...document.querySelectorAll(".message_native")].map((e) => {
                        const r = e.getBoundingClientRect();
                        return [r.top, r.bottom, r.width];
                    }),
                });
                const before = geometry();
                window.cleanup = [...document.querySelectorAll("li")].map(runs.joinMessageRun);
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
                const after = geometry();
                const row = document.querySelector("#last"),
                    body = row.firstElementChild.getBoundingClientRect();
                return {
                    before,
                    after,
                    top: body.top,
                    bottom: body.bottom,
                    width: body.width,
                    tail: parseFloat(row.style.getPropertyValue("--vc-sharedkey-tail")),
                    active: row.classList.contains("vc-sharedkey-run-end"),
                };
            });
            assert.deepEqual(
                state.after,
                state.before,
                "Tail painting cannot alter native message or scroll geometry",
            );
            assert.equal(state.tail, Math.min(footer, spacing));
            assert.equal(state.active, footer > 0);
            if (footer) {
                await page.evaluate(async () => {
                    const row = document.querySelector("#last");
                    row.append(row.querySelector(".message_native"));
                    await new Promise(requestAnimationFrame);
                    await new Promise(requestAnimationFrame);
                });
                assert.equal(
                    await page.$eval("#last", (row) =>
                        row.firstElementChild.classList.contains("message_native"),
                    ),
                    true,
                    "Native row updates keep the message first and the paint last",
                );
                async function sample() {
                    const data = await page.screenshot({ encoding: "base64" });
                    return page.evaluate(
                        async ({ data, dpr, state }) => {
                            const image = new Image();
                            image.src = "data:image/png;base64," + data;
                            await image.decode();
                            const canvas = document.createElement("canvas");
                            canvas.width = image.width;
                            canvas.height = image.height;
                            const context = canvas.getContext("2d");
                            context.drawImage(image, 0, 0);
                            const pixel = (x, y) => [
                                ...context.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data,
                            ];
                            return {
                                accent: pixel(300, 510),
                                tail: [1, 300, state.width - 2].map((x) =>
                                    pixel(x, state.bottom + state.tail / 2),
                                ),
                                after: pixel(300, state.bottom + state.tail + 2),
                                body: pixel(300, state.top + 20),
                                bodyReference: pixel(300, 535),
                                border: pixel(1, state.top + 20),
                            };
                        },
                        { data, dpr, state },
                    );
                }
                const resting = await sample();
                for (const pixel of resting.tail)
                    assert.deepEqual(
                        pixel,
                        resting.accent,
                        "Tail uses full-width accent fill without reply tint or yellow gutter",
                    );
                assert.notDeepEqual(
                    resting.body,
                    resting.accent,
                    "Native reply body keeps its separate highlight",
                );
                assert.deepEqual(
                    resting.body,
                    resting.bodyReference,
                    "The extension cannot double-tint the message body",
                );
                assert.deepEqual(resting.border, [240, 178, 50, 255]);
                if (footer > spacing)
                    assert.deepEqual(
                        resting.after,
                        [0, 0, 0, 255],
                        "Extension stops after one normal message gap",
                    );
                await page.mouse.move(300, state.top + 20);
                const hovered = await sample();
                assert.deepEqual(hovered.tail, resting.tail, "Body hover cannot change tail color");
                assert.notDeepEqual(hovered.body, resting.body);
                await page.mouse.move(300, state.bottom + state.tail / 2);
                assert.deepEqual(
                    (await sample()).body,
                    resting.body,
                    "Tail does not extend the native message hover target",
                );
                if (dpr === 1 && !compact && spacing === 16)
                    await page.screenshot({ path: root + "/.test-output/message-tail.png" });
            }
            await page.evaluate(async () => {
                const plain = document.createElement("li");
                plain.id = "plain";
                plain.innerHTML = '<div class="message_native"></div>';
                document.querySelector("#footer").before(plain);
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
            });
            assert.equal(
                await page.$eval("#last", (row) => row.classList.contains("vc-sharedkey-run-end")),
                false,
                "A later ordinary message removes the encrypted tail",
            );
            assert.equal(
                await page.$(".vc-sharedkey-tail"),
                null,
                "A later ordinary message removes the paint node",
            );
            await page.evaluate(() => window.cleanup.forEach((fn) => fn()));
            assert.equal(
                await page.$eval("#last", (row) => row.style.getPropertyValue("--vc-sharedkey-tail")),
                "",
                "Cleanup restores tail state",
            );
            assert.equal(
                await page.$(".vc-sharedkey-tail"),
                null,
                "Cleanup removes the decorative paint node",
            );
        }
    }
    console.log(
        "PASS full-width final-message accent, compact/group spacing, bounded footer fill, stable hover/scroll, plaintext transitions, and cleanup at three display scales",
    );
} finally {
    await browser.close();
}
