import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { root, vencord } from "../scripts/paths.mjs";
import { chromeExecutable } from "./browser.mjs";

const require = createRequire(import.meta.url);
const work = path.join(root, ".test-output", "options-ui");
await mkdir(work, { recursive: true });
const boundary = path.join(work, "boundary.tsx");
await writeFile(
    boundary,
    `
import React from "react";
export { useState, useEffect, useLayoutEffect, useRef } from "react";
export const classes=(...args)=>args.filter(Boolean).join(" ");
export const Modal=({children})=><div role="dialog">{children}</div>;
export const Button=({children,disabled,onClick})=><button disabled={disabled} onClick={onClick}>{children}</button>;
export const TextButton=Button;
export const CopyIcon=()=>null; export const EyeIcon=()=>null;
`,
);
const result = await build({
    stdin: {
        resolveDir: root,
        loader: "tsx",
        contents: `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import * as storage from "@api/DataStore";
import { EncryptionOptions } from "./src/Options";
import { withReadingPreferences } from "./src/ReadingPreferences";
import { rememberReadingPolicy, readingEnabled } from "./src/ReadingPolicy";
import "./src/style.css";
const channel="123456789012345678";
window.backendEnabled=true;
const info=()=>({enabled:window.backendEnabled,fingerprint:window.noKey?"":"test",keyCount:1,keyIds:["test"],color:"#7d52ff",method:"shared",identityFingerprint:"",identityVerified:false,identityChanged:false,exchangePending:false,exchangeExpired:false,...(location.search.includes("new")?{reading:true,previews:"automatic"}:{})});
const backend={channelInfo:async()=>info(),revealKey:async()=>"synthetic-fixture-key",setEnabled:async(_id,value)=>{window.saveCalls=(window.saveCalls??0)+1;if(window.holdSave)await new Promise(resolve=>window.finishSave=resolve);if(window.failSave)throw new Error("Synthetic save failure");window.backendEnabled=value;return info();}};
const native=withReadingPreferences(backend,{get:storage.get,set:async(...args)=>{if(window.failStorage)throw new Error("Synthetic preference failure");return storage.set(...args);}});
window.native=native;
function Harness(){const [current,setCurrent]=useState(null);return <><output id="active-reading">{current?(readingEnabled(channel)?"reading":"raw"):"loading"}</output><EncryptionOptions channelId={channel} channelName="Fixture chat" rootProps={{}} native={native} onUpdate={next=>{rememberReadingPolicy(channel,next);setCurrent(next);}} onMethod={async()=>info()} onExchange={async()=>info()} /></>}
createRoot(document.getElementById("root")).render(<Harness/>);
`,
    },
    bundle: true,
    define: { IS_REPORTER: "false" },
    platform: "browser",
    jsx: "automatic",
    outdir: work,
    write: false,
    plugins: [
        {
            name: "vencord-boundary",
            setup(b) {
                b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => ({
                    path: require.resolve(args.path),
                }));
                b.onResolve({ filter: /^@components\/FormSwitch$/ }, () => ({
                    path: path.join(vencord, "src/components/FormSwitch.tsx"),
                }));
                b.onResolve({ filter: /^@api\/DataStore$/ }, () => ({
                    path: path.join(vencord, "src/api/DataStore/index.ts"),
                }));
                b.onResolve({ filter: /^@utils\/css$/ }, () => ({
                    path: path.join(vencord, "src/utils/css.ts"),
                }));
                b.onResolve({ filter: /^@/ }, () => ({ path: boundary }));
            },
        },
    ],
});
const html =
    '<html><style>body{background:#111;color:#ddd;font:14px sans-serif;margin:20px} [role=dialog]{width:460px;max-height:85vh;overflow:auto;padding:20px;--primary-400:#666;--brand-500:#7356ef;--text-default:#ddd;--text-subtle:#aaa;--input-background:#222;--border-subtle:#333}</style><div id="root"></div></html>';
const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({
    executablePath: chromeExecutable(),
    headless: true,
    args: ["--no-first-run", ...(process.env.CI ? ["--no-sandbox"] : [])],
});
try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const load = async (suffix) => {
        await page.goto(url + suffix);
        await page.addStyleTag({
            content: result.outputFiles.find((file) => file.path.endsWith(".css")).text,
        });
        await page.addScriptTag({
            content: result.outputFiles.find((file) => file.path.endsWith(".js")).text,
        });
        await page.waitForFunction(
            () =>
                document.querySelector("#active-reading")?.textContent !== "loading" &&
                !document.querySelector("input[type=checkbox]")?.disabled,
        );
    };
    const state = () =>
        page.evaluate(() => ({
            checked: [...document.querySelectorAll("input[type=checkbox]")].map((input) => input.checked),
            preview: document.querySelector("#vc-sharedkey-previews").value,
            disabled: document.querySelector("#vc-sharedkey-previews").disabled,
            active: document.querySelector("#active-reading").textContent,
        }));
    await load("");
    assert.deepEqual(await state(), {
        checked: [true, true],
        preview: "automatic",
        disabled: false,
        active: "reading",
    });
    await page.evaluate(() => {
        window.originalForm = document.querySelector(".vc-sharedkey-options");
        window.originalKeyInput = document.querySelector("#vc-sharedkey-input");
        window.disabledChanges = [];
        window.formObserver = new MutationObserver((records) => {
            for (const record of records)
                if (record.attributeName === "disabled") window.disabledChanges.push(record.target.tagName);
        });
        window.formObserver.observe(window.originalForm, { subtree: true, attributes: true });
    });
    await page.click("input[type=checkbox]");
    await page.waitForFunction(
        () => !window.backendEnabled && !document.querySelector("input[type=checkbox]").disabled,
    );
    assert.deepEqual((await state()).checked, [false, true]);
    await page.click(".vc-sharedkey-toggle-row:nth-of-type(2) input");
    await page.waitForFunction(() => document.querySelector("#active-reading").textContent === "raw");
    assert.equal((await state()).disabled, false);
    await page.select("#vc-sharedkey-previews", "never");
    await page.waitForFunction(() => !document.querySelector("#vc-sharedkey-previews").disabled);
    assert.deepEqual(await state(), {
        checked: [false, false],
        preview: "never",
        disabled: false,
        active: "raw",
    });
    assert.deepEqual(
        await page.evaluate(() => window.disabledChanges),
        [],
        "quick settings saves must not flash the entire form disabled",
    );
    assert.ok(
        await page.evaluate(
            () =>
                window.originalForm === document.querySelector(".vc-sharedkey-options") &&
                window.originalKeyInput === document.querySelector("#vc-sharedkey-input"),
        ),
        "saving settings must preserve the mounted form and key field",
    );
    await page.evaluate(() => {
        window.formObserver.disconnect();
        window.holdSave = true;
        window.saveCalls = 0;
        const input = document.querySelector("input[type=checkbox]");
        input.click();
        input.click();
    });
    await page.waitForFunction(() => document.querySelector("input[type=checkbox]").disabled);
    assert.equal(
        await page.evaluate(() => window.saveCalls),
        1,
        "overlapping writes are blocked immediately",
    );
    await page.evaluate(() => {
        window.holdSave = false;
        window.finishSave();
    });
    await page.waitForFunction(() => !document.querySelector("input[type=checkbox]").disabled);
    assert.equal((await state()).checked[0], true);
    await load("?new");
    assert.deepEqual(await state(), {
        checked: [true, false],
        preview: "never",
        disabled: false,
        active: "raw",
    });
    await page.evaluate(() => {
        window.backendEnabled = false;
        window.dispatchEvent(new Event("focus"));
    });
    await page.waitForFunction(() => !document.querySelector("input[type=checkbox]").checked);
    await page.evaluate(() => {
        window.noKey = true;
        window.dispatchEvent(new Event("focus"));
    });
    await page.waitForFunction(() => !document.querySelector(".vc-sharedkey-fingerprint"));
    assert.equal(
        await page.$eval("input[type=checkbox]", (input) => input.disabled),
        false,
        "pending key setup must not permanently disable the outgoing switch",
    );
    await page.evaluate(() => {
        window.failSave = true;
    });
    await page.click("input[type=checkbox]");
    await page.waitForFunction(() =>
        document.querySelector('[role="alert"]')?.textContent.includes("Synthetic save failure"),
    );
    assert.equal((await state()).checked[0], false);
    assert.ok(
        await page.$eval('[role="alert"]', (el) => el.getBoundingClientRect().top < 200),
        "errors must be visible above the controls",
    );
    await page.evaluate(() => {
        window.failStorage = true;
    });
    await page.select("#vc-sharedkey-previews", "automatic");
    await page.waitForFunction(() =>
        document.querySelector('[role="alert"]')?.textContent.includes("Synthetic preference failure"),
    );
    assert.equal((await state()).preview, "never");
    await page.evaluate(() => {
        window.failStorage = false;
    });
    await page.select("#vc-sharedkey-previews", "manual");
    await page.waitForFunction(() => document.querySelector("#vc-sharedkey-previews").value === "manual");
    await load("?new");
    assert.equal(
        (await state()).preview,
        "manual",
        "an explicit On click preference overrides the Automatic default",
    );
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(work, "options.png") });
    console.log(
        "PASS real Options + Vencord FormSwitch/Switch: stable controls during quick saves, slow-save feedback and overlapping-write guard, legacy backend defaults, mouse toggles, reading/preview independence, IndexedDB persistence across reload and backend upgrade, external state sync, and visible save failures",
    );
} finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
}
