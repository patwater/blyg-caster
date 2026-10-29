// Farcaster CastAdd and CastRemove messages, encoded, hashed and signed
// without @farcaster/core.
//
// @farcaster/core would pull viem and faker into the Worker bundle for what is
// a few dozen bytes of protobuf. This file writes those bytes by hand, in the
// exact field order ts-proto uses (packed `mentions` and `mentionsPositions`
// are always written, even when empty), hashes them with BLAKE3 truncated to
// 20 bytes, and signs the hash with Ed25519 through WebCrypto. The test suite
// checks every byte against vectors produced by @farcaster/core 0.21.0 itself
// (scripts/farcaster-golden-vectors.mjs → test/farcaster/fixtures/).
//
// The signer key is the owner's app signer (an Ed25519 key registered to their
// FID by their custody wallet, outside the Worker). It is never the custody key.

import { blake3 } from "@noble/hashes/blake3.js";
import { toFarcasterTime } from "./normalize.ts";
import { FarcasterError } from "./types.ts";
import type { CastRef } from "./types.ts";

const MESSAGE_TYPE_CAST_ADD = 1;
const MESSAGE_TYPE_CAST_REMOVE = 2;
const FARCASTER_NETWORK_MAINNET = 1;
const HASH_SCHEME_BLAKE3 = 1;
const SIGNATURE_SCHEME_ED25519 = 1;
const CAST_TYPE_CAST = 0;
const CAST_TYPE_LONG_CAST = 1;

/** A minimal protobuf writer: varints, length-delimited fields, nothing else. */
class Writer {
  private parts: number[] = [];
  varint(n: number): this {
    if (!Number.isSafeInteger(n) || n < 0) throw new FarcasterError("config", `cannot encode ${n} as a varint`);
    let v = n;
    while (v > 0x7f) {
      this.parts.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.parts.push(v);
    return this;
  }
  tag(field: number, wireType: 0 | 2): this {
    return this.varint(field * 8 + wireType);
  }
  uint(field: number, n: number): this {
    return this.tag(field, 0).varint(n);
  }
  bytes(field: number, b: Uint8Array): this {
    this.tag(field, 2).varint(b.length);
    for (const x of b) this.parts.push(x);
    return this;
  }
  string(field: number, s: string): this {
    return this.bytes(field, new TextEncoder().encode(s));
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export interface CastAddInput {
  text: string;
  embeds: string[];
  parent?: CastRef;
  parentUrl?: string;
}

function encodeCastId(ref: CastRef): Uint8Array {
  return new Writer().uint(1, ref.fid).bytes(2, hexToBytes(ref.hash)).finish();
}

function encodeCastAddBody(input: CastAddInput): Uint8Array {
  const w = new Writer();
  w.bytes(2, new Uint8Array()); // mentions: packed, written even when empty
  if (input.parent) w.bytes(3, encodeCastId(input.parent));
  if (input.parentUrl !== undefined) w.string(7, input.parentUrl);
  if (input.text !== "") w.string(4, input.text);
  w.bytes(5, new Uint8Array()); // mentionsPositions: packed, written even when empty
  for (const url of input.embeds) w.bytes(6, new Writer().string(1, url).finish());
  const type = new TextEncoder().encode(input.text).length > 320 ? CAST_TYPE_LONG_CAST : CAST_TYPE_CAST;
  if (type !== 0) w.uint(8, type);
  return w.finish();
}

function encodeMessageData(type: number, fid: number, timestamp: number, field: 5 | 6, body: Uint8Array): Uint8Array {
  return new Writer().uint(1, type).uint(2, fid).uint(3, timestamp).uint(4, FARCASTER_NETWORK_MAINNET).bytes(field, body).finish();
}

export function castAddData(fid: number, at: Date, input: CastAddInput): Uint8Array {
  return encodeMessageData(MESSAGE_TYPE_CAST_ADD, fid, toFarcasterTime(at), 5, encodeCastAddBody(input));
}

export function castRemoveData(fid: number, at: Date, targetHash: string): Uint8Array {
  return encodeMessageData(MESSAGE_TYPE_CAST_REMOVE, fid, toFarcasterTime(at), 6, new Writer().bytes(1, hexToBytes(targetHash)).finish());
}

export interface SignedMessage {
  /** `0x` + 40 hex: the message's identity, and a CastAdd's cast hash. */
  hash: string;
  /** The encoded protobuf Message, as POST /v1/submitMessage takes it. */
  bytes: Uint8Array;
}

/** Hash and sign MessageData bytes into a Message. */
export async function signMessage(dataBytes: Uint8Array, signer: Ed25519Signer): Promise<SignedMessage> {
  const hash = blake3(dataBytes, { dkLen: 20 });
  const signature = await signer.sign(hash);
  const bytes = new Writer()
    .bytes(1, dataBytes)
    .bytes(2, hash)
    .uint(3, HASH_SCHEME_BLAKE3)
    .bytes(4, signature)
    .uint(5, SIGNATURE_SCHEME_ED25519)
    .bytes(6, signer.publicKey)
    .bytes(7, dataBytes)
    .finish();
  return { hash: bytesToHex(hash), bytes };
}

export interface Ed25519Signer {
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/**
 * A signer from the 32-byte private key held in the FARCASTER_SIGNER_KEY
 * secret, as `0x`-prefixed or bare hex. The key is imported into WebCrypto
 * once and never logged, returned or stored anywhere else.
 */
export async function ed25519Signer(privateKeyHex: string): Promise<Ed25519Signer> {
  const hex = privateKeyHex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new FarcasterError("config", "FARCASTER_SIGNER_KEY must be 32 bytes of hex");
  const seed = hexToBytes("0x" + hex.toLowerCase());
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  } catch {
    throw new FarcasterError("config", "FARCASTER_SIGNER_KEY is not a valid Ed25519 key");
  }
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  if (!jwk.x) throw new FarcasterError("config", "could not derive the signer's public key");
  const publicKey = base64UrlToBytes(jwk.x);
  return {
    publicKey,
    async sign(message) {
      return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, message));
    },
  };
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new FarcasterError("config", "invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
