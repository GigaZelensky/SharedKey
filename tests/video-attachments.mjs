import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { chromeExecutable } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(root, ".test-output", "video");
await mkdir(work, { recursive: true });
await writeFile(
    path.join(work, "stub.js"),
    "export const showToast=()=>{}; export const findByCodeLazy=()=>async url=>url; export const findByPropsLazy=()=>({}); export const MessageStore={getMessage:()=>undefined}; export const UserStore={getCurrentUser:()=>({id:'self'})};",
);
const result = await build({
    stdin: {
        contents:
            "export * from './src/LocalImageActions'; export * from './src/VideoMetadata'; export * from './src/FileAttachments'; export * from './src/ReadingPolicy'; export * from './src/ReceiveMessages';",
        resolveDir: root,
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "fixture",
    write: false,
    plugins: [
        {
            name: "vencord-boundary",
            setup(b) {
                b.onResolve({ filter: /^@/ }, () => ({ path: path.join(work, "stub.js") }));
            },
        },
    ],
});
const browser = await puppeteer.launch({
    executablePath: chromeExecutable(),
    headless: true,
    args: ["--no-first-run", ...(process.env.CI ? ["--no-sandbox"] : [])],
});
try {
    const page = await browser.newPage();
    const remote = [];
    page.on("request", (request) => {
        if (/^https?:/.test(request.url())) remote.push(request.url());
    });
    await page.setContent("<html><body></body></html>");
    await page.addScriptTag({ content: result.outputFiles[0].text });
    const fixtures = await Promise.all(
        ["mp4", "webm"].map(async (ext) => ({
            filename: `local-video.${ext}`,
            mime: `video/${ext}`,
            data: (await readFile(path.join(root, "tests", "fixtures", `local-video.${ext}`))).toString(
                "base64",
            ),
        })),
    );
    const checks = await page.evaluate(async (fixtures) => {
        const channel = "123456789012345678";
        const outputs = [];
        const created = [],
            revoked = [];
        const originalCreate = URL.createObjectURL.bind(URL),
            originalRevoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            const url = originalCreate(blob);
            created.push(url);
            return url;
        };
        URL.revokeObjectURL = (url) => {
            revoked.push(url);
            originalRevoke(url);
        };
        for (const [index, { mime, filename, data }] of fixtures.entries()) {
            const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
            const native = {
                channelInfo: async () => ({ reading: true, previews: "never" }),
                decryptAttachment: async () => ({ filename, mime, data: bytes }),
            };
            const message = {
                id: String(index + 100),
                channel_id: channel,
                author: { id: "sender" },
                content: "",
                attachments: [
                    {
                        id: String(index + 200),
                        filename: "encrypted.vcs",
                        size: bytes.length,
                        url: `https://cdn.discordapp.com/attachments/${channel}/123/encrypted.vcs`,
                    },
                ],
            };
            await fixture.prepareAttachmentViews(native, message);
            const view = fixture.attachmentView(channel, message.attachments[0].id);
            if (!view?.poster) {
                if (!view)
                    throw new Error(
                        "No decrypted file: " + fixture.attachmentError(channel, message.attachments[0].id),
                    );
                try {
                    await fixture.localVideoMetadata(view.url);
                } catch (error) {
                    throw new Error(`${mime}: ${bytes.length} bytes: ${error.message}`);
                }
                throw new Error("Video metadata missing from cached file");
            }
            const dto = fixture.receivedPayload(message, channel).attachments[0];
            const poster = new Image();
            poster.src = view.poster;
            await poster.decode();
            const pixelCanvas = document.createElement("canvas");
            pixelCanvas.width = 1;
            pixelCanvas.height = 1;
            const pixelCtx = pixelCanvas.getContext("2d");
            pixelCtx.drawImage(poster, 0, 0, 1, 1);
            const pixel = [...pixelCtx.getImageData(0, 0, 1, 1).data];
            const player = document.createElement("video");
            player.muted = true;
            player.src = dto.url;
            await player.play();
            await new Promise((resolve) => setTimeout(resolve, 50));
            player.pause();
            outputs.push({
                mime,
                width: dto.width,
                height: dto.height,
                local: dto.url.startsWith("blob:"),
                pixel,
                played: player.currentTime > 0,
            });
            player.removeAttribute("src");
            player.load();
        }
        const badUrl = URL.createObjectURL(new Blob(["not a video"], { type: "video/mp4" }));
        let invalidRejected = false;
        try {
            await fixture.localVideoMetadata(badUrl, 150);
        } catch {
            invalidRejected = true;
        }
        URL.revokeObjectURL(badUrl);
        let remoteRejected = false;
        try {
            await fixture.localVideoMetadata("https://example.com/video.mp4");
        } catch {
            remoteRejected = true;
        }
        const broken = {
            id: "999",
            channel_id: channel,
            author: { id: "sender" },
            content: "",
            attachments: [
                {
                    id: "998",
                    filename: "encrypted.vcs",
                    size: 5,
                    url: `https://cdn.discordapp.com/attachments/${channel}/123/encrypted.vcs`,
                },
            ],
        };
        await fixture.prepareAttachmentViews(
            {
                channelInfo: async () => ({ reading: true }),
                decryptAttachment: async () => ({
                    filename: "broken.mp4",
                    mime: "video/mp4",
                    data: new Uint8Array([1, 2, 3]),
                }),
            },
            broken,
        );
        const fallback = fixture.receivedPayload(broken, channel).attachments[0];
        let savedFilename;
        const removeActions = fixture.installLocalImageActions({
            saveDecryptedAttachment: async (filename) => {
                savedFilename = filename;
                return true;
            },
        });
        const download = document.createElement("a");
        download.href = fallback.url;
        document.body.appendChild(download);
        download.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
        removeActions();
        fixture.clearAttachmentCache();
        return {
            outputs,
            invalidRejected,
            remoteRejected,
            savedFilename,
            fallback: {
                filename: fallback.filename,
                width: fallback.width ?? null,
                local: fallback.url.startsWith("blob:"),
            },
            allRevoked: created.every((url) => revoked.includes(url)),
        };
    }, fixtures);
    assert.equal(remote.length, 0, "metadata, poster decoding and playback must not contact a remote host");
    for (const video of checks.outputs) {
        assert.equal(video.width, 320);
        assert.equal(video.height, 180);
        assert.ok(video.local && video.played);
        assert.ok(video.pixel[0] > 170 && video.pixel[1] < 100, "poster contains the decoded red frame");
    }
    assert.equal(checks.savedFilename, "broken.mp4");
    assert.ok(checks.invalidRejected && checks.remoteRejected && checks.allRevoked);
    assert.deepEqual(checks.fallback, { filename: "broken.mp4", width: null, local: true });
    console.log(
        `PASS real browser video decode/playback (${checks.outputs.map((v) => v.mime).join(", ")}), local poster pixels, raw attachment dimensions, zero remote requests, invalid-file fallback and blob cleanup`,
    );
} finally {
    await browser.close();
}
