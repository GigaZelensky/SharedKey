import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".test-output", "gif-resolver.mjs");
await mkdir(path.dirname(output), { recursive: true });
await build({
    entryPoints: [path.join(root, "src", "gifResolver.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
});
const resolver = await import(pathToFileURL(output));
const mediaOutput = path.join(root, ".test-output", "media-links.mjs");
await build({
    entryPoints: [path.join(root, "src", "mediaLinks.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: mediaOutput,
});
const media = await import(pathToFileURL(mediaOutput));
const expiredGif =
    "https://cdn.discordapp.com/attachments/123456789012345678/234567890123456789/watermark.gif?ex=1&is=1&hm=old";
const refreshedGif = expiredGif.replace("ex=1&is=1&hm=old", "ex=ffffffff&is=2&hm=fresh");
assert.deepEqual(media.previewLinks(expiredGif), [{ page: false, url: expiredGif }]);
assert.equal(
    await media.refreshDiscordImage(expiredGif, async (url) => {
        assert.equal(url, expiredGif);
        return refreshedGif;
    }),
    refreshedGif,
);
assert.equal(media.previewLinks(expiredGif.replace("cdn.discordapp.com", "images.discordapp.net")).length, 1);
assert.equal(
    media.previewLinks(expiredGif.replace("cdn.discordapp.com", "cdn-canary.discordapp.com")).length,
    1,
);
assert.equal(media.previewLinks(expiredGif.replace("watermark.gif", "my%20animation%2Egif")).length, 1);
assert.equal(media.gifUrl(expiredGif.replace("watermark.gif", "my%20animation%2Egif")), true);
assert.equal(media.previewLinks("`" + expiredGif + "`").length, 0);
assert.equal(media.previewLinks("<" + expiredGif + ">").length, 0);
assert.equal(media.previewLinks("||" + expiredGif + "||").length, 0);
for (const url of [
    expiredGif.replace("cdn.discordapp.com", "example.invalid"),
    expiredGif.replace("https:", "http:"),
    expiredGif.replace("watermark.gif", "private.zip"),
]) {
    assert.equal(media.discordImageUrl(url), undefined);
    await assert.rejects(
        media.refreshDiscordImage(url, () => {
            throw new Error("Must not refresh unsupported URLs");
        }),
        /Unsupported/,
    );
}
await assert.rejects(
    media.refreshDiscordImage(expiredGif, async () =>
        refreshedGif.replace("234567890123456789", "999999999999999999"),
    ),
    /different attachment/,
);
await assert.rejects(
    media.refreshDiscordImage(expiredGif, async () =>
        refreshedGif.replace("cdn.discordapp.com", "example.invalid"),
    ),
    /different attachment/,
);
console.log(
    "PASS Discord attachment GIF recognition, signed URL refresh, encoded filenames, suppression and resource validation",
);

const metadata =
    '<meta property="og:image" content="https://static2.klipy.com/thumbnail.webp"><meta property="og:image" content="https://static2.klipy.com/animation.gif">';
assert.equal(resolver.gifMetadata(metadata, "klipy").url, "https://static2.klipy.com/animation.gif");
assert.equal(
    resolver.gifMetadata(
        '<meta property="og:video" content="https://media.tenor.com/animation.mp4">',
        "tenor",
    ).video,
    true,
);
assert.equal(
    resolver.gifMetadata('<meta property="og:image" content="https://example.invalid/image.gif">', "tenor"),
    null,
);
for (const value of [
    "https://tenor.com.example.invalid/view/test",
    "https://user:pass@tenor.com/view/test",
    "https://tenor.com:8443/view/test",
    "http://klipy.com/gifs/test",
    "https://127.0.0.1/gifs/test",
])
    assert.equal(resolver.gifPage(value), undefined);

const originalFetch = globalThis.fetch;
try {
    let requests = 0;
    globalThis.fetch = async (_url, options) => {
        requests++;
        assert.equal(options.credentials, "omit");
        assert.equal(options.redirect, "manual");
        return new Response('<meta property="og:image" content="https://media1.tenor.com/test.gif">', {
            headers: { "content-type": "text/html" },
        });
    };
    const [first, second] = await Promise.all([
        resolver.resolveGif("https://tenor.com/view/test-123"),
        resolver.resolveGif("https://tenor.com/view/test-123"),
    ]);
    assert.deepEqual(first, second);
    assert.equal(requests, 1);
    globalThis.fetch = async () =>
        new Response("x".repeat(512 * 1024 + 1), { headers: { "content-type": "text/html" } });
    assert.equal(await resolver.resolveGif("https://klipy.com/gifs/too-large"), null);
    globalThis.fetch = async () =>
        new Response(null, { status: 302, headers: { location: "https://example.invalid/gifs/test" } });
    assert.equal(await resolver.resolveGif("https://klipy.com/gifs/redirect"), null);
} finally {
    globalThis.fetch = originalFetch;
}
console.log(
    "PASS GIF metadata selection, host validation, bounded downloads, deduplication, and redirect rejection (offline fixtures)",
);
