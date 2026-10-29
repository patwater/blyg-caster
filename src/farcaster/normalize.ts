// Shared pieces of normalization: hashes, timestamps, URLs and embeds. The
// backend-specific halves live in hub.ts and neynar.ts.

import type { Cast, CastEmbed } from "./types.ts";
import { isCastHash, isFid } from "./types.ts";

/** Farcaster time is seconds since 2021-01-01T00:00:00Z (@farcaster/core FARCASTER_EPOCH). */
export const FARCASTER_EPOCH_MS = 1_609_459_200_000;

export const fromFarcasterTime = (seconds: number): string => new Date(FARCASTER_EPOCH_MS + seconds * 1000).toISOString();
export const toFarcasterTime = (date: Date): number => Math.floor((date.getTime() - FARCASTER_EPOCH_MS) / 1000);

/**
 * The web page for a cast is a display detail built from a template, never
 * the cast's identity. `{handle}`, `{fid}`, `{hash}` and `{shortHash}` (the
 * hash's first 10 characters, `0x` + 8 hex, as farcaster.xyz links use) are
 * replaced. A template that needs a handle the backend did not give falls back
 * to the handle-free conversation URL.
 */
export const DEFAULT_CAST_URL_TEMPLATE = "https://farcaster.xyz/{handle}/{shortHash}";
export const FALLBACK_CAST_URL_TEMPLATE = "https://farcaster.xyz/~/conversations/{hash}";

export function castWebUrl(cast: { fid: number; hash: string; handle: string | null }, template = DEFAULT_CAST_URL_TEMPLATE): string {
  const chosen = template.includes("{handle}") && !cast.handle ? FALLBACK_CAST_URL_TEMPLATE : template;
  const url = chosen
    .replaceAll("{handle}", encodeURIComponent(cast.handle ?? ""))
    .replaceAll("{fid}", String(cast.fid))
    .replaceAll("{shortHash}", cast.hash.slice(0, 10))
    .replaceAll("{hash}", cast.hash);
  return isHttpUrl(url) ? url : castWebUrl(cast, FALLBACK_CAST_URL_TEMPLATE);
}

export function isHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|avif)(?:$|[?#])/i;
/** Hosts that serve images at extension-less URLs. Farcaster clients upload to these. */
const IMAGE_HOSTS = ["imagedelivery.net", "i.imgur.com"];

export function looksLikeImage(url: string, contentType?: string | null): boolean {
  if (contentType) return /^image\//i.test(contentType);
  try {
    const u = new URL(url);
    return IMAGE_PATH.test(u.pathname) || IMAGE_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/** Lowercase `0x` hex from `0x` hex or base64 (protobuf JSON's encoding of bytes), or null. */
export function normalizeHash(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const lower = raw.toLowerCase();
  if (isCastHash(lower)) return lower;
  if (/^[0-9a-f]{40}$/.test(lower)) return "0x" + lower;
  if (/^[A-Za-z0-9+/]{27}=$/.test(raw)) {
    try {
      const bin = atob(raw);
      if (bin.length !== 20) return null;
      let out = "0x";
      for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, "0");
      return out;
    } catch {
      return null;
    }
  }
  return null;
}

export function toFid(raw: unknown): number | null {
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  return isFid(n) ? n : null;
}

/** A cast's text is capped well above the protocol's 10 KB long casts, so one bad record cannot bloat the store. */
export const MAX_TEXT_CHARS = 12_000;

/** Final validation of a normalized cast; anything that fails is dropped from its page. */
export function validCast(c: Cast): boolean {
  return (
    isFid(c.fid) &&
    isCastHash(c.hash) &&
    typeof c.text === "string" &&
    c.text.length <= MAX_TEXT_CHARS &&
    !Number.isNaN(Date.parse(c.createdAt)) &&
    isHttpUrl(c.url) &&
    (c.parentHash === null || isCastHash(c.parentHash)) &&
    Array.isArray(c.embeds)
  );
}

export function cleanText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Control characters other than newline and tab never belong in a cast.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, MAX_TEXT_CHARS);
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return s ? s.slice(0, 120) : null;
}

export function dedupeEmbeds(embeds: CastEmbed[]): CastEmbed[] {
  const seen = new Set<string>();
  return embeds.filter((e) => {
    const key = e.type === "cast" ? `cast:${e.cast.hash}` : e.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function clampLimit(limit: number | undefined, max: number, fallback = 25): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return fallback;
  return Math.min(Math.floor(limit), max);
}

/** Newest first, ties broken by hash so a merged feed has one stable order. */
export function newestFirst(a: Cast, b: Cast): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
}
