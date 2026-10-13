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
    await build({
        entryPoints: [root + "/src/mediaLinks.ts"],
        bundle: true,
        format: "iife",
        globalName: "mediaLinks",
        outfile: root + "/.test-output/media-links-browser.js",
    });
    await page.addScriptTag({
        content: await readFile(root + "/.test-output/media-links-browser.js", "utf8"),
    });
    const expired =
        "https://cdn.discordapp.com/attachments/123456789012345678/234567890123456789/crop.gif?ex=1&hm=old";
    const fresh = expired.replace("ex=1&hm=old", "ex=ffffffff&hm=new");
    await page.setRequestInterception(true);
    page.on("request", (request) => {
        if (request.url() === expired) void request.respond({ status: 403, body: "Expired signature" });
        else if (request.url() === fresh)
            void request.respond({
                status: 200,
                contentType: "image/gif",
                body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
            });
        else void request.continue();
    });
    const decoded = await page.evaluate(
        async ({ expired, fresh }) => {
            const old = new Image();
            old.src = expired;
            let oldFailed = false;
            try {
                await old.decode();
            } catch {
                oldFailed = true;
            }
            const refreshed = await mediaLinks.refreshDiscordImage(expired, async () => fresh);
            const image = new Image();
            image.src = refreshed;
            await image.decode();
            return {
                oldFailed,
                width: image.naturalWidth,
                height: image.naturalHeight,
                gif: mediaLinks.gifUrl(refreshed),
            };
        },
        { expired, fresh },
    );
    assert.deepEqual(decoded, { oldFailed: true, width: 1, height: 1, gif: true });
    console.log(
        "PASS an expired Discord GIF fails its original image preflight and decodes after signed-URL refresh",
    );
    await page.setViewport({ width: 600, height: 600, deviceScaleFactor: 1 });
    // The same native hover rectangle must be tinted even when the virtual item is taller.
    for (const dpr of [1, 1.25, 1.5, 2]) {
        await page.setViewport({ width: 600, height: 600, deviceScaleFactor: dpr });
        for (const [height, top, bottom, margin] of [
            [24, 0, 12, 0],
            [73.25, 9, 3, 16],
            [241.5, 3, 11, 24],
        ]) {
            await page.mouse.move(590, 590);
            await page.setContent(
                `<style>body{margin:0;background:black}ol{margin:0;padding:0;list-style:none}li{padding:${top}px 0 ${bottom}px;--vc-sharedkey-fill:rgba(125,82,255,.14);--vc-sharedkey-hover:rgba(125,82,255,.105)}.message_native{position:relative;height:${height}px;margin-top:${margin}px}.message_native:hover{background:rgba(125,82,255,.14)}</style><style>${css}</style><ol><li id=height-row data-sharedkey-channel=chat><div class=message_native></div></li></ol><script>${js}</script>`,
            );
            const box = await page.$eval(".message_native", (n) => ({
                top: n.getBoundingClientRect().top,
                height: n.getBoundingClientRect().height,
            }));
            await page.mouse.move(300, box.top + box.height / 2);
            const nativeHover = await page.screenshot();
            await page.mouse.move(590, 590);
            await page.evaluate(async () => {
                const row = document.querySelector("#height-row");
                row.classList.add("vc-sharedkey-row");
                window.cleanupHeight = runs.joinMessageRun(row);
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
            });
            const tint = await page.screenshot();
            const masks = await page.evaluate(
                async (images) => {
                    const masks = [];
                    for (const data of images) {
                        const image = new Image();
                        image.src = "data:image/png;base64," + data;
                        await image.decode();
                        const canvas = document.createElement("canvas");
                        canvas.width = image.width;
                        canvas.height = image.height;
                        const ctx = canvas.getContext("2d");
                        ctx.drawImage(image, 0, 0);
                        const x = Math.floor(image.width / 2);
                        const bg = ctx.getImageData(x, image.height - 1, 1, 1).data;
                        masks.push(
                            Array.from({ length: image.height }, (_, y) => {
                                const p = ctx.getImageData(x, y, 1, 1).data;
                                return p[0] !== bg[0] || p[1] !== bg[1] || p[2] !== bg[2];
                            }),
                        );
                    }
                    return masks;
                },
                [nativeHover.toString("base64"), tint.toString("base64")],
            );
            const differences = masks[0].flatMap((value, i) => (value !== masks[1][i] ? [i] : []));
            assert.ok(
                differences.every(
                    (y) =>
                        Math.abs(y - box.top * dpr) <= 1 || Math.abs(y - (box.top + box.height) * dpr) <= 1,
                ),
                `Only fractional edge rasterization can differ: ${JSON.stringify({ dpr, height, top, bottom, margin, differences })}`,
            );
            assert.ok(masks[1].some(Boolean), "Tint must paint the native message");
            const measured = await page.$eval("#height-row", (n) => [
                parseFloat(n.style.getPropertyValue("--vc-sharedkey-body-top")) +
                    n.getBoundingClientRect().top,
                parseFloat(n.style.getPropertyValue("--vc-sharedkey-body-bottom")) +
                    n.getBoundingClientRect().top,
            ]);
            assert.deepEqual(
                measured,
                [box.top, box.top + box.height],
                "Tint uses exact native hover geometry",
            );
            await page.evaluate(() => window.cleanupHeight());
        }
    }
    console.log(
        "PASS 12 native-hover/tint bounds comparisons (one device-pixel fractional-edge rasterization tolerance) across wrapper padding, margins, text/media heights, and display scales",
    );
    await page.setContent(
        `<style>body{margin:0;background:black}ol{margin:0;padding:0;list-style:none}li{height:80px;--vc-sharedkey-fill:rgba(125,82,255,.14);--vc-sharedkey-hover:rgba(125,82,255,.105);--vc-sharedkey-gap-fill:rgb(17,11,36);--vc-sharedkey-gap-hover:rgb(13,9,27);--vc-sharedkey-gap:16px;--vc-sharedkey-seam:2px}.native-mentioned::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:rgb(240,178,50)}</style><style>${css}</style><ol><li id=row class="vc-sharedkey-row vc-sharedkey-run-continuation vc-sharedkey-mentioned"><div class=message_native><button id=action>Message action</button></div></li><li id=native class="vc-sharedkey-row native-mentioned" style="position:relative;margin-top:16px"><div class=message_native>Native reply mention</div></li></ol>`,
    );
    await page.mouse.move(590, 590);
    const resting = await page.$eval("#row", (node) => getComputedStyle(node).backgroundImage);
    const restingGap = await page.$eval("#row", (node) => getComputedStyle(node, "::after").backgroundColor);
    await page.click("#action");
    const hovered = await page.$eval("#row", (node) => getComputedStyle(node).backgroundImage);
    assert.notEqual(hovered, resting);
    assert.equal(
        await page.$eval("#row", (node) => getComputedStyle(node, "::after").backgroundColor),
        restingGap,
        "Hover changes the message body, never the paint filling the gap between authors",
    );
    await page.mouse.move(590, 590);
    assert.equal(await page.$eval("#action", (node) => node === document.activeElement), true);
    assert.equal(await page.$eval("#row", (node) => getComputedStyle(node).backgroundImage), resting);
    assert.equal(
        await page.$eval("#row", (node) => getComputedStyle(node, "::after").backgroundColor),
        restingGap,
    );
    assert.equal(
        await page.$eval("#row", (node) => getComputedStyle(node, "::before").backgroundColor),
        "rgb(240, 178, 50)",
    );
    assert.equal(
        await page.$eval("#native", (node) => getComputedStyle(node, "::before").backgroundColor),
        "rgb(240, 178, 50)",
    );
    console.log(
        "PASS body hover clears after pointer exit with a focused action; inter-message gap tint stays constant and local/native yellow bars remain",
    );
    console.log(
        `PASS ${checked} pixel cases: fractional rows, 100/125/150/200% scaling, zero/16/24px gaps, dark/light backgrounds, no dark or doubled-tint seam, foreground preserved, unchanged scroll geometry. Old shadow reproduced ${oldSeams} dark pixels.`,
    );
} finally {
    await browser.close();
}
