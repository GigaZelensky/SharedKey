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
