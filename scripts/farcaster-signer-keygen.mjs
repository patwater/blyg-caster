// Make a new Ed25519 app signer key for blygcaster's hub backend.
//
//   node scripts/farcaster-signer-keygen.mjs ~/.config/blygcaster/signer.key
//
// Writes the PRIVATE key (64 hex characters) to the file you name, readable
// only by you, and prints the PUBLIC key. The private key goes into the
// Worker as a secret and nowhere else:
//
//   npx wrangler secret put FARCASTER_SIGNER_KEY < ~/.config/blygcaster/signer.key
//
// The public key is what your custody wallet registers to your FID, once,
// outside the Worker (docs/blygcaster-signer.md). This script never sees, asks
// for or accepts a custody key or a recovery phrase, and nothing here touches
// the network.
import { webcrypto } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/farcaster-signer-keygen.mjs <file to write the private key to>");
  process.exit(1);
}
const file = path.resolve(target);
const repo = path.resolve(import.meta.dirname, "..");
if (file === repo || file.startsWith(repo + path.sep)) {
  console.error("Refusing to write a private key inside the repository. Choose a path outside it, such as ~/.config/blygcaster/signer.key.");
  process.exit(1);
}
if (existsSync(file)) {
  console.error(`${file} already exists. Refusing to overwrite a key.`);
  process.exit(1);
}

const { privateKey, publicKey } = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", privateKey));
const seed = pkcs8.slice(pkcs8.length - 32);
const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", publicKey));
const hex = (b) => Buffer.from(b).toString("hex");

writeFileSync(file, "0x" + hex(seed), { mode: 0o600, flag: "wx" });
console.log(`Private key written to ${file} (mode 600). Do not commit, paste or share it.`);
console.log(`Public key, to register to your FID: 0x${hex(raw)}`);
