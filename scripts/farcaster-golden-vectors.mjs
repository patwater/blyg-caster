// Golden vectors for blygcaster's hand-written Farcaster message encoder.
//
// src/farcaster/message.ts encodes, hashes and signs CastAdd and CastRemove
// messages without depending on @farcaster/core (which pulls viem and faker
// into a Worker bundle). This script produces the same messages with
// @farcaster/core itself, so test/farcaster/message.test.ts can check the
// encoder byte for byte. @farcaster/core is NOT a dependency of this repo:
// install it somewhere else and pass that directory.
//
//   mkdir /tmp/fcgen && (cd /tmp/fcgen && npm init -y && npm i @farcaster/core@0.21.0)
//   node scripts/farcaster-golden-vectors.mjs /tmp/fcgen > test/farcaster/fixtures/golden-messages.json
//
// The private key below is a fixed, public test key. It is not registered to
// any FID and must never be.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/farcaster-golden-vectors.mjs <dir containing node_modules/@farcaster/core>");
const require = createRequire(path.join(path.resolve(dir), "noop.js"));
const core = require("@farcaster/core");
const corePkg = JSON.parse(readFileSync(path.join(path.resolve(dir), "node_modules/@farcaster/core/package.json"), "utf8"));

const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

const TEST_PRIVATE_KEY = "0x" + "11".repeat(32);
const signer = new core.NobleEd25519Signer(bytes(TEST_PRIVATE_KEY));
const dataOptions = { fid: 424242, network: core.FarcasterNetwork.MAINNET, timestamp: 150000000 };

const castAdds = [
  {
    name: "plain cast with one url embed",
    body: { text: "A new fragment on my blyg", embeds: [{ url: "https://blyg.example.com/f/abc123/" }] },
  },
  {
    name: "cast in a channel (parentUrl)",
    body: { text: "Posted to a channel", embeds: [{ url: "https://blyg.example.com/t/xyz/" }], parentUrl: "https://farcaster.xyz/~/channel/water" },
  },
  {
    name: "reply to a cast (parentCastId)",
    body: {
      text: "My stub answers this: https://blyg.example.com/t/stub1/",
      embeds: [{ url: "https://blyg.example.com/t/stub1/" }],
      parentCastId: { fid: 3, hash: bytes("0x" + "ab".repeat(20)) },
    },
  },
  {
    name: "multibyte text, no embeds",
    body: { text: "Rivers — and the 🏞️ that shape them. Ça coule.", embeds: [] },
  },
];

const out = { generator: `@farcaster/core@${corePkg.version}`, privateKey: TEST_PRIVATE_KEY, dataOptions, castAdds: [], castRemoves: [] };

for (const c of castAdds) {
  const body = { embedsDeprecated: [], mentions: [], mentionsPositions: [], type: core.CastType.CAST, ...c.body };
  const r = await core.makeCastAdd(body, { ...dataOptions }, signer);
  if (r.isErr()) throw r.error;
  const m = r.value;
  out.castAdds.push({
    name: c.name,
    input: {
      text: c.body.text,
      embeds: c.body.embeds.map((e) => e.url),
      parentUrl: c.body.parentUrl,
      parentCastId: c.body.parentCastId ? { fid: c.body.parentCastId.fid, hash: hex(c.body.parentCastId.hash) } : undefined,
    },
    dataBytes: hex(m.dataBytes),
    hash: hex(m.hash),
    signature: hex(m.signature),
    signer: hex(m.signer),
    message: hex(core.Message.encode(m).finish()),
    json: core.Message.toJSON(m),
  });
}

const target = "0x" + "cd".repeat(20);
const rr = await core.makeCastRemove({ targetHash: bytes(target) }, { ...dataOptions }, signer);
if (rr.isErr()) throw rr.error;
out.castRemoves.push({
  name: "remove a cast",
  input: { targetHash: target },
  dataBytes: hex(rr.value.dataBytes),
  hash: hex(rr.value.hash),
  signature: hex(rr.value.signature),
  signer: hex(rr.value.signer),
  message: hex(core.Message.encode(rr.value).finish()),
  json: core.Message.toJSON(rr.value),
});

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
