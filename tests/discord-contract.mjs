// Optional local contract check against an independently obtained Discord JS
// bundle. No Discord source is copied into this repository or shipped package.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const file = process.env.DISCORD_BUNDLE;
if (!file) throw new Error("Set DISCORD_BUNDLE to the current Discord web bundle.");
const bundle = await readFile(file, "utf8");
function moduleSource(id) {
    const start = bundle.indexOf(`${id}(e,t,n){`);
    assert.ok(start >= 0, `Discord module ${id} must still exist; review a changed bundle`);
    const tail = bundle.slice(start);
    const end = tail.search(/},\d+\(e,t,n\)\{/);
    assert.ok(end > 0);
    return tail.slice(0, end + 1).replace(/^\d+/, "function");
}
let sequence = 0;
class Record {
    constructor(fields) {
        Object.assign(this, fields);
    }
    toJS() {
        return { ...this };
    }
    set(key, value) {
        return new Record({ ...this, [key]: value });
    }
}
const constants = {
    Auw: { IMAGE: "image", GIFV: "gifv", RICH: "rich", ARTICLE: "article" },
    qNw: { IS_ANIMATED: 1 },
    MRS: { NON_PARSED: new Set() },
    lAJ: {},
    pr7: {},
};
const dependencies = {
    435558: { uniqueId: (prefix) => prefix + ++sequence },
    536637: (value) => value,
    317097: { $k: (value) => value },
    665260: { Lt: (flags, mask) => !!(flags & mask) },
    437517: { ZV: (value) => value },
    935208: { default: { extractTimestamp: () => Date.now() } },
    652215: constants,
    581619: { pd: new Set(["rich"]) },
    721779: { Ay: (value) => [value] },
    315069: { A: Record },
    889227: { A: Record },
    383233: { go: Record, Ay: Record, vF: Record },
    280450: { default: { getId: () => "self" } },
    994500: { A: { isBlockedForMessage: () => false, isIgnoredForMessage: () => false } },
    287809: { default: { getUser: () => undefined } },
    45938: { pF: () => false, e7: () => [] },
    451919: {
        Uj: ({ mentionUsers }) => mentionUsers.includes("self"),
        Ay: ({ message }) => message.mentions.includes("self"),
    },
};
function load(source, globals = {}) {
    const exports = {};
    const require = (id) => dependencies[id] ?? {};
    require.d = (target, getters) =>
        Object.defineProperties(
            target,
            Object.fromEntries(Object.entries(getters).map(([name, get]) => [name, { get }])),
        );
    require.n = (value) => () => value;
    vm.runInNewContext(`(${source})`, { URL, Date, Map, Set, ...globals })(null, exports, require);
    return exports;
}
const embeds = (dependencies[659674] = load(moduleSource(659674)));
const converter = load(moduleSource(320095));
const image = {
    url: "https://cdn.discordapp.com/emojis/example.webp",
    proxy_url: "https://cdn.discordapp.com/emojis/example.webp",
    width: 128,
    height: 128,
    content_type: "image/webp",
};
const raw = {
    id: "123",
    channel_id: "456",
    author: { id: "sender" },
    timestamp: "2026-10-12T00:00:00Z",
    type: 0,
    content: "plain",
    mentions: [{ id: "self" }],
    embeds: [{ type: "image", url: image.url, thumbnail: image }],
};
const record = converter.rh(raw);
assert.equal(record.content, "plain");
assert.equal(record.mentioned, true);
assert.equal(record.embeds[0].image.contentType, "image/webp");
assert.equal(record.embeds[0].image.width, 128);
assert.equal(embeds.NV(record.embeds[0]), true);
assert.equal(embeds.NV({ ...record.embeds[0], rawTitle: "" }), false);
const video = {
    ...image,
    url: "https://media.tenor.com/example.mp4",
    proxy_url: "https://media.tenor.com/example.mp4",
    content_type: "video/mp4",
};
const gifv = embeds.fK(raw.channel_id, raw.id, { type: "gifv", url: video.url, video, thumbnail: video });
assert.equal(embeds.NV(gifv), true);
assert.ok(gifv.video);
const edited = converter.IU(record, {
    ...raw,
    content: "edited plaintext",
    edited_timestamp: "2026-10-12T00:01:00Z",
});
assert.equal(edited.content, "edited plaintext");
assert.equal(edited.editedTimestamp.toISOString(), "2026-10-12T00:01:00.000Z");
const patch = /null!=([A-Za-z_$][\w$]*)\.content&&""!==\1\.content&&/;
const source = moduleSource(320095);
assert.equal([...source.matchAll(new RegExp(patch.source, "g"))].length, 1);
const patched = load(
    source.replace(patch, 'null!=$1.content&&(""!==$1.content||$1.sharedkey_local_update)&&'),
);
assert.equal(patched.IU(record, { content: "", sharedkey_local_update: true }).content, "");
assert.equal(patched.IU(record, { content: "" }).content, "plain");
assert.ok(bundle.includes('type:"LOAD_MESSAGES_SUCCESS"'));
assert.ok(!bundle.includes('type:"MESSAGE_LOAD_SUCCESS"'));
console.log(
    "PASS current Discord raw-message conversion, mentions, edited timestamp, inline image/GIF classification, local empty-content update, and actual history action name",
);

// Execute the actual background consumer's entry function with a captured
// resolver. The patch must prevent decrypted codes reaching that resolver.
const manager = moduleSource(79153);
const consumerMatch =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{(?=[A-Za-z_$][\w$]*\(\2\.content\?\?null,\2\.channel_id\))/;
assert.equal([...manager.matchAll(new RegExp(consumerMatch.source, "g"))].length, 1);
const match = consumerMatch.exec(manager);
const consumerSource = manager.slice(match.index, manager.indexOf("class ", match.index));
const resolverName = consumerSource.match(/\{([A-Za-z_$][\w$]*)\(/)[1];
const plain = { id: "123", channel_id: "456", content: "https://discord.new/private-template-code" };
const wire = { ...plain, content: "[VCS1:opaque]" };
const resolved = [];
const scope = { [resolverName]: (text) => resolved.push(text), $self: { networkMessage: () => wire } };
vm.runInNewContext(`(${consumerSource})`, scope)(plain);
assert.equal(
    resolved.pop(),
    plain.content,
    "unpatched manager automatically consumes decrypted link content",
);
const protectedConsumer = consumerSource.replace(consumerMatch, "$&$2=$self.networkMessage($2);");
vm.runInNewContext(`(${protectedConsumer})`, scope)(plain);
assert.equal(resolved.pop(), wire.content);
assert.equal(plain.content, "https://discord.new/private-template-code");
console.log(
    "PASS actual background link-consumer patch feeds ciphertext to its resolver while keeping native UI input unchanged",
);

assert.equal(
    bundle.split('"MessageCodedLinkManager"').length - 1,
    1,
    "the network-consumer patch anchor must be unique",
);
const uploader = moduleSource(280889);
const batchUploader = moduleSource(395780);
assert.equal([...uploader.matchAll(/async upload\(\)\{/g)].length, 1);
assert.equal([...batchUploader.matchAll(/async uploadFiles\([A-Za-z_$][\w$]*\)\{/g)].length, 1);
const protectedUploader = uploader.replace(/async upload\(\)\{/, "$&await $self.guardUploads([this]);");
const uploadBody = protectedUploader.slice(protectedUploader.indexOf("async upload(){"));
assert.ok(uploadBody.indexOf("await $self.guardUploads") < uploadBody.indexOf("getUploadPayload(this)"));
assert.ok(
    uploadBody.indexOf("getUploadPayload(this)") <
        uploadBody.indexOf("getCreateAttachmentURL(this.channelId)"),
);
console.log(
    "PASS current native upload guard anchors execute before upload metadata/reservation and byte transfer",
);

const codedLinkPatch =
    /codedLinks:([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.NON_PARSED\.has\(([A-Za-z_$][\w$]*)\.type\)\?\[\]:)/;
const giftPatch = /giftCodes:(?=\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\)\(([A-Za-z_$][\w$]*)\))/;
assert.equal([...source.matchAll(new RegExp(codedLinkPatch.source, "g"))].length, 1);
assert.equal([...source.matchAll(new RegExp(giftPatch.source, "g"))].length, 1);
let codedCalls = 0,
    giftCalls = 0;
dependencies[721779].Ay = () => {
    codedCalls++;
    return ["native-link"];
};
dependencies[45938].e7 = () => {
    giftCalls++;
    return ["native-gift"];
};
const controlled = load(
    source
        .replace(codedLinkPatch, "codedLinks:$self.blockNativeUnfurl($2)?[]:$1")
        .replace(giftPatch, "giftCodes:$self.blockNativeUnfurl($1)?[]:"),
    { $self: { blockNativeUnfurl: (message) => message.id === "private" } },
);
const privateRecord = controlled.rh({ ...raw, id: "private" });
assert.equal(codedCalls + giftCalls, 0);
assert.equal(privateRecord.content, raw.content);
assert.equal(privateRecord.codedLinks.length, 0);
assert.equal(privateRecord.giftCodes.length, 0);
controlled.rh(raw);
assert.ok(codedCalls > 0 && giftCalls > 0);
console.log(
    "PASS native converter leaves encrypted links as ordinary text without generating automatic invite/gift widgets; ordinary messages unchanged",
);
