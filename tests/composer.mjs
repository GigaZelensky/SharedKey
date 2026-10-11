import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { chromeExecutable } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".test-output", "composer.js");
await mkdir(path.dirname(output), { recursive: true });
await build({
    entryPoints: [path.join(root, "src", "ComposerAccent.ts")],
    bundle: true,
    format: "iife",
    globalName: "accent",
    outfile: output,
});
const script = await readFile(output, "utf8");
const css = await readFile(path.join(root, "src", "style.css"), "utf8");
const browser = await puppeteer.launch({
    executablePath: chromeExecutable(),
    headless: true,
    userDataDir: path.join(root, ".test-output", "composer-profile"),
    args: process.env.CI ? ["--no-sandbox"] : [],
});
try {
    const page = await browser.newPage();
    await page.setContent(
        `<style>body{background:black}.scrollableContainer_native{width:500px;height:60px;background:#111214}</style><style>${css}</style><form id=first><div class=channelTextArea_native><div class=scrollableContainer_decoy></div><div class=scrollableContainer_native><svg id=lock></svg></div></div></form><script>${script}</script>`,
    );
    await page.evaluate(() => {
        window.binding = accent.bindComposerAccent(document.querySelector("#lock"), {
            enabled: true,
            color: "#7d52ff",
        });
    });
    await page.waitForFunction(
        () =>
            !document
                .querySelector(".scrollableContainer_native")
                .classList.contains("vc-sharedkey-composer-initial"),
    );
    assert.equal(
        await page.$eval(".scrollableContainer_native", (node) =>
            node.classList.contains("vc-sharedkey-composer-surface"),
        ),
        true,
    );
    assert.equal(
        await page.$eval(".scrollableContainer_decoy", (node) =>
            node.classList.contains("vc-sharedkey-composer-surface"),
        ),
        false,
    );

    await page.evaluate(() => {
        const composer = document.querySelector(".channelTextArea_native");
        composer.className = "channelTextArea_native";
        composer.style.removeProperty("--vc-sharedkey-composer-border");
        document.querySelector(".scrollableContainer_native").className = "scrollableContainer_native";
    });
    await page.waitForFunction(
        () =>
            document.querySelector(".channelTextArea_native").classList.contains("vc-sharedkey-composer") &&
            document
                .querySelector(".scrollableContainer_native")
                .classList.contains("vc-sharedkey-composer-surface"),
    );
    assert.match(
        await page.$eval(".channelTextArea_native", (node) =>
            node.style.getPropertyValue("--vc-sharedkey-composer-border"),
        ),
        /0\.7/,
    );

    await page.evaluate(() => {
        const original = document.querySelector(".scrollableContainer_native");
        const replacement = original.cloneNode(false);
        replacement.className = "scrollableContainer_native";
        while (original.firstChild) replacement.append(original.firstChild);
        original.replaceWith(replacement);
    });
    await page.waitForFunction(() =>
        document
            .querySelector(".scrollableContainer_native")
            .classList.contains("vc-sharedkey-composer-surface"),
    );
    assert.equal(
        await page.evaluate(() =>
            document.querySelector(".channelTextArea_native").classList.contains("vc-sharedkey-composer"),
        ),
        true,
    );
    const states = await page.evaluate(async () => {
        const values = [];
        const observer = new MutationObserver(() =>
            values.push(
                document.querySelector(".channelTextArea_native").classList.contains("vc-sharedkey-composer"),
            ),
        );
        observer.observe(document.querySelector("#first"), { attributes: true, subtree: true });
        binding.update({ enabled: true, color: "#7d52ff" });
        await new Promise(requestAnimationFrame);
        observer.disconnect();
        return values;
    });
    assert.equal(
        states.some((value) => !value),
        false,
        "On-to-on update never clears the accent",
    );
    await page.evaluate(() => binding.update({ enabled: false, color: "#7d52ff" }));
    assert.equal(
        await page.evaluate(() =>
            document.querySelector(".channelTextArea_native").classList.contains("vc-sharedkey-composer"),
        ),
        false,
    );
    assert.equal(
        await page.$eval(
            ".scrollableContainer_native",
            (node) => getComputedStyle(node).transitionDuration.split(",")[0],
        ),
        "0.12s",
    );
    await page.evaluate(() => binding.dispose());
    assert.equal(
        await page.$eval(".scrollableContainer_native", (node) =>
            node.classList.contains("vc-sharedkey-composer-surface"),
        ),
        false,
    );
    console.log(
        "PASS composer lifecycle, wrapper replacement, class repair, correct input targeting, on-to-on stability, toggles, and cleanup",
    );
} finally {
    await browser.close();
}
