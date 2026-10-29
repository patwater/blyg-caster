// blygcaster's Farcaster settings and secrets, and the adapters they select.
//
// Settings that are not secret live in D1 (`farcaster_config`) and are edited
// in Settings → Farcaster. Secrets are Worker secrets only, and this module
// reports whether each one is set, never its value:
//
//   FARCASTER_SIGNER_KEY   hub sink: the app signer's Ed25519 private key (hex)
//   FARCASTER_HUB_API_KEY  hub source and sink: x-api-key, for a node that wants one
//   NEYNAR_API_KEY         Neynar source and sink
//   NEYNAR_SIGNER_UUID     Neynar sink: a managed signer approved by the owner
//   FARCASTER_FAKE         "1" selects the in-memory fake adapters (local dev only)
//
// Nothing personal is hardcoded: every setting starts empty or at a neutral
// default, so another operator can run this fork on their own account.

import type { Env } from "../types.ts";
import { nowIso } from "../util.ts";
import { demoCasts, FakeCastSink, FakeCastSource } from "./fake.ts";
import { farcasterHttp } from "./http.ts";
import type { HttpFn } from "./http.ts";
import { HubCastSink, HubCastSource } from "./hub.ts";
import { NeynarCastSink, NeynarCastSource } from "./neynar.ts";
import { DEFAULT_CAST_URL_TEMPLATE, isHttpUrl } from "./normalize.ts";
import type { CastSink } from "./sink.ts";
import type { CastSource } from "./source.ts";
import type { FarcasterAccount } from "./types.ts";
import { FarcasterError, isFid } from "./types.ts";

export interface FarcasterEnv extends Env {
  FARCASTER_SIGNER_KEY?: string;
  FARCASTER_HUB_API_KEY?: string;
  NEYNAR_API_KEY?: string;
  NEYNAR_SIGNER_UUID?: string;
  FARCASTER_FAKE?: string;
}

export type Backend = "hub" | "neynar";

export interface FarcasterSettings {
  /** The owner's FID: who cross-posts are cast as. Empty until set. */
  fid: number | null;
  read_backend: Backend;
  write_backend: Backend;
  /** The Snapchain node's HTTP API. No default: the operator chooses a node. */
  hub_url: string;
  cast_url_template: string;
  /** The global kill switch. When false, nothing is cast or deleted. */
  crosspost_enabled: boolean;
  /** Every cross-post goes to this channel; empty for none (Q17). */
  crosspost_channel_id: string;
  /** The channel's parent URL, which the hub backend needs. */
  crosspost_channel_parent_url: string;
  /** Appended to a cast whose item discloses generated text (Q18). */
  ai_note: string;
}

export const DEFAULT_SETTINGS: FarcasterSettings = {
  fid: null,
  read_backend: "hub",
  write_backend: "hub",
  hub_url: "",
  cast_url_template: DEFAULT_CAST_URL_TEMPLATE,
  crosspost_enabled: true,
  crosspost_channel_id: "",
  crosspost_channel_parent_url: "",
  ai_note: "Includes AI-generated text.",
};

export async function getFarcasterSettings(db: D1Database): Promise<FarcasterSettings> {
  const rows = (await db.prepare("SELECT key, value FROM farcaster_config").all<{ key: string; value: string }>()).results;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const backend = (v: string | undefined, d: Backend): Backend => (v === "hub" || v === "neynar" ? v : d);
  const fid = Number(map.get("fid"));
  return {
    fid: isFid(fid) ? fid : null,
    read_backend: backend(map.get("read_backend"), DEFAULT_SETTINGS.read_backend),
    write_backend: backend(map.get("write_backend"), DEFAULT_SETTINGS.write_backend),
    hub_url: map.get("hub_url") ?? DEFAULT_SETTINGS.hub_url,
    cast_url_template: map.get("cast_url_template") || DEFAULT_SETTINGS.cast_url_template,
    crosspost_enabled: map.has("crosspost_enabled") ? map.get("crosspost_enabled") === "1" : DEFAULT_SETTINGS.crosspost_enabled,
    crosspost_channel_id: map.get("crosspost_channel_id") ?? "",
    crosspost_channel_parent_url: map.get("crosspost_channel_parent_url") ?? "",
    ai_note: map.has("ai_note") ? (map.get("ai_note") ?? "") : DEFAULT_SETTINGS.ai_note,
  };
}

/** Validate a partial update. Returns an error sentence, or null when it is acceptable. */
export function settingsProblem(patch: Partial<FarcasterSettings>): string | null {
  if (patch.fid !== undefined && patch.fid !== null && !isFid(patch.fid)) return "fid must be a positive integer";
  if (patch.hub_url !== undefined && patch.hub_url !== "" && !isHttpUrl(patch.hub_url)) return "hub_url must be an absolute http(s) URL";
  if (patch.cast_url_template !== undefined && patch.cast_url_template !== "") {
    const sample = patch.cast_url_template.replaceAll(/\{(handle|fid|hash|shortHash)\}/g, "x");
    if (!isHttpUrl(sample) || !/\{(hash|shortHash)\}/.test(patch.cast_url_template)) return "cast_url_template must be an http(s) URL naming {hash} or {shortHash}";
  }
  if (patch.crosspost_channel_id !== undefined && patch.crosspost_channel_id !== "" && !/^[a-z0-9-]{1,64}$/i.test(patch.crosspost_channel_id)) return "crosspost_channel_id is letters, digits and hyphens";
  if (patch.crosspost_channel_parent_url !== undefined && patch.crosspost_channel_parent_url !== "" && !isHttpUrl(patch.crosspost_channel_parent_url)) return "crosspost_channel_parent_url must be an absolute http(s) URL";
  if (patch.ai_note !== undefined && patch.ai_note.length > 80) return "ai_note is at most 80 characters";
  return null;
}

export async function putFarcasterSettings(db: D1Database, patch: Partial<FarcasterSettings>): Promise<FarcasterSettings> {
  const writes: D1PreparedStatement[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
    const stored = value === null ? "" : typeof value === "boolean" ? (value ? "1" : "0") : String(value).trim();
    writes.push(db.prepare("INSERT INTO farcaster_config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, stored));
  }
  if (writes.length) await db.batch(writes);
  return getFarcasterSettings(db);
}

/** Which secrets are set. Booleans only: a secret's value never leaves the Worker. */
export function secretStatus(env: FarcasterEnv) {
  const set = (v: string | undefined) => !!v && !!v.trim();
  return {
    FARCASTER_SIGNER_KEY: set(env.FARCASTER_SIGNER_KEY),
    FARCASTER_HUB_API_KEY: set(env.FARCASTER_HUB_API_KEY),
    NEYNAR_API_KEY: set(env.NEYNAR_API_KEY),
    NEYNAR_SIGNER_UUID: set(env.NEYNAR_SIGNER_UUID),
  };
}

const isFake = (env: FarcasterEnv) => env.FARCASTER_FAKE === "1";

// One fake network per isolate, so a local `wrangler dev` session reads back
// what it cast. Tests replace these with their own via setFakeAdapters().
let fakes: { source: FakeCastSource; sink: FakeCastSink } | null = null;
export function fakeAdapters(): { source: FakeCastSource; sink: FakeCastSink } {
  fakes ??= { source: new FakeCastSource(demoCasts()), sink: new FakeCastSink() };
  return fakes;
}
export function setFakeAdapters(next: { source: FakeCastSource; sink: FakeCastSink } | null): void {
  fakes = next;
}

// Tests install their own adapters here; production never sets it.
let override: { source?: CastSource; sink?: CastSink } | null = null;
export function overrideAdapters(next: { source?: CastSource; sink?: CastSink } | null): void {
  override = next;
}

/** A D1-backed name cache for the hub source, so a poll does not look up the same author every time. */
export function accountCache(db: D1Database) {
  const FRESH_MS = 7 * 24 * 3600 * 1000;
  return {
    async get(fid: number): Promise<FarcasterAccount | null> {
      const row = await db.prepare("SELECT handle, display_name, fetched_at FROM farcaster_accounts WHERE fid = ?").bind(fid).first<{ handle: string | null; display_name: string | null; fetched_at: string }>();
      if (!row || Date.now() - Date.parse(row.fetched_at) > FRESH_MS) return null;
      return { fid, handle: row.handle, displayName: row.display_name };
    },
    async put(account: FarcasterAccount): Promise<void> {
      await db
        .prepare("INSERT INTO farcaster_accounts (fid, handle, display_name, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT (fid) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name, fetched_at = excluded.fetched_at")
        .bind(account.fid, account.handle, account.displayName, nowIso())
        .run();
    },
  };
}

export function castSource(env: FarcasterEnv, settings: FarcasterSettings, http: HttpFn = farcasterHttp(env)): CastSource {
  if (override?.source) return override.source;
  if (isFake(env)) return fakeAdapters().source;
  if (settings.read_backend === "neynar") {
    return new NeynarCastSource({ apiKey: env.NEYNAR_API_KEY ?? "", http, castUrlTemplate: settings.cast_url_template });
  }
  if (!settings.hub_url) throw new FarcasterError("config", "set a hub URL in Settings → Farcaster");
  return new HubCastSource({ url: settings.hub_url, http, apiKey: env.FARCASTER_HUB_API_KEY, castUrlTemplate: settings.cast_url_template, accountCache: accountCache(env.DB) });
}

export function castSink(env: FarcasterEnv, settings: FarcasterSettings, http: HttpFn = farcasterHttp(env)): CastSink {
  if (override?.sink) return override.sink;
  if (isFake(env)) return fakeAdapters().sink;
  if (settings.write_backend === "neynar") {
    return new NeynarCastSink({ apiKey: env.NEYNAR_API_KEY ?? "", signerUuid: env.NEYNAR_SIGNER_UUID ?? "", http });
  }
  if (!settings.hub_url) throw new FarcasterError("config", "set a hub URL in Settings → Farcaster");
  if (!env.FARCASTER_SIGNER_KEY) throw new FarcasterError("config", "FARCASTER_SIGNER_KEY is not set (see docs/blygcaster-signer.md)");
  return new HubCastSink({ url: settings.hub_url, http, apiKey: env.FARCASTER_HUB_API_KEY, fid: settings.fid ?? 0, signerKey: env.FARCASTER_SIGNER_KEY });
}
