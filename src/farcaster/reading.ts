// Farcaster sources in the reader (brief §5, "Reading").
//
// A source (an account or a channel) is an ordinary subscription of kind
// 'farcaster', and each cast is an ordinary L0 row in imported_items: link =
// the cast's web URL, summary = its text. So the reading view, the source
// filter, read state, hoppers and the stub action all work unchanged, and the
// importer's scheduler polls Farcaster sources on its usual 30-minute cycle.
//
// The whole source spec is in the subscription's feed_url, so deleting the
// subscription through the ordinary route leaves nothing behind:
//
//   farcaster://account/3
//   farcaster://channel/water?parent_url=https%3A%2F%2F…
//
// Farcaster subscriptions never join the public blogroll or its OPML
// (listBlogrollSubscriptions excludes the kind): who the owner reads on
// Farcaster is not published.

import { renderMarkdown } from "../markdown.ts";
import type { SubscriptionRow } from "../types.ts";
import { contentHash, nowIso } from "../util.ts";
import { appendFlag, createSubscription, findSubscription, getImportedItem, recordPollFailure, recordPollSuccess, refreshSourceTitle, upsertL0Item } from "../importer/store.ts";
import type { FarcasterEnv } from "./config.ts";
import { castSource, getFarcasterSettings } from "./config.ts";
import { castWebUrl, FALLBACK_CAST_URL_TEMPLATE, isHttpUrl } from "./normalize.ts";
import type { CastSource } from "./source.ts";
import type { Cast, CastRef, ChannelRef } from "./types.ts";
import { FarcasterError, isCastHash, isFid } from "./types.ts";

export type SourceSpec = { kind: "account"; fid: number } | { kind: "channel"; channel: ChannelRef };

export function specToFeedUrl(spec: SourceSpec): string {
  if (spec.kind === "account") return `farcaster://account/${spec.fid}`;
  const q = spec.channel.parentUrl ? `?parent_url=${encodeURIComponent(spec.channel.parentUrl)}` : "";
  return `farcaster://channel/${spec.channel.id}${q}`;
}

export function parseSourceSpec(feedUrl: string): SourceSpec | null {
  const m = /^farcaster:\/\/(account|channel)\/([^/?#]+)(?:\?(.*))?$/.exec(feedUrl);
  if (!m) return null;
  if (m[1] === "account") {
    const fid = Number(m[2]);
    return isFid(fid) ? { kind: "account", fid } : null;
  }
  if (!/^[a-z0-9-]{1,64}$/i.test(m[2])) return null;
  const parentUrl = new URLSearchParams(m[3] ?? "").get("parent_url");
  return { kind: "channel", channel: { id: m[2], parentUrl: parentUrl && isHttpUrl(parentUrl) ? parentUrl : null } };
}

/** A cast's local id in imported_items. Carries the cast's identity, so a stub can name it without a lookup. */
export const castRemoteId = (ref: CastRef): string => `fc-${ref.fid}-${ref.hash}`;

export function parseCastRemoteId(remoteId: string): CastRef | null {
  const m = /^fc-(\d+)-(0x[0-9a-f]{40})$/.exec(remoteId);
  if (!m) return null;
  const fid = Number(m[1]);
  return isFid(fid) && isCastHash(m[2]) ? { fid, hash: m[2] } : null;
}

export const isFarcasterSubscription = (sub: Pick<SubscriptionRow, "kind">): boolean => (sub.kind as string) === "farcaster";

/**
 * Escape the markdown a cast's text could trip, and nothing else. URLs are
 * left bare so markdown-it's linkify still links them; html is off anyway.
 */
export function escapeCastText(text: string): string {
  const parts = text.split(/(https?:\/\/[^\s<>()]+)/g);
  const escaped = parts.map((part, i) => (i % 2 === 1 ? part : part.replace(/[\\`*_[\]<>#!|~&]/g, "\\$&"))).join("");
  return escaped
    .split("\n")
    .map((line) => line.replace(/^(\s*)([-+=])/, "$1\\$2").replace(/^(\s*\d+)([.)])/, "$1\\$2"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/([^\n])\n(?=[^\n])/g, "$1\\\n");
}

/** The author line a reader sees, and the label a stub's citation starts with. */
export function authorLabel(cast: Pick<Cast, "displayName" | "handle" | "fid">): string {
  const name = cast.displayName ?? (cast.handle ? null : `fid ${cast.fid}`);
  const handle = cast.handle ? `@${cast.handle}` : null;
  return name && handle ? `${name} (${handle})` : (name ?? handle ?? `fid ${cast.fid}`);
}

const shortUrl = (url: string): string => {
  try {
    const u = new URL(url);
    const shown = u.host + u.pathname.replace(/\/$/, "") + u.search;
    return shown.length > 60 ? shown.slice(0, 59) + "…" : shown;
  } catch {
    return url;
  }
};

const mdLabel = (s: string): string => s.replace(/[\\[\]]/g, "\\$&");

/**
 * A cast as L0 markdown: the author as a link to the cast (the anchor the
 * Studio reads as an L0 entry's title and link), the text, images inline, and
 * other embeds as plain links (Q4). No counts of any kind.
 */
export function castMarkdown(cast: Cast, template?: string): string {
  const channel = cast.channel && !isHttpUrl(cast.channel) ? ` · /${cast.channel}` : "";
  const lines = [`[${mdLabel(authorLabel(cast))}](${cast.url})${channel}`];
  if (cast.parentHash) {
    const parent = castWebUrl({ fid: cast.parentFid ?? 0, hash: cast.parentHash, handle: null }, FALLBACK_CAST_URL_TEMPLATE);
    lines.push(`↩ in reply to [a cast](${parent})`);
  }
  lines.push("");
  if (cast.text.trim()) lines.push(escapeCastText(cast.text.trim()), "");
  const extras: string[] = [];
  for (const e of cast.embeds) {
    if (e.type === "image") extras.push(`![image from the cast](${e.url})`);
    else if (e.type === "link") extras.push(`[${mdLabel(shortUrl(e.url))}](${e.url})`);
    else extras.push(`↪ quotes [a cast](${castWebUrl({ ...e.cast, handle: null }, template && !template.includes("{handle}") ? template : FALLBACK_CAST_URL_TEMPLATE)})`);
  }
  if (extras.length) lines.push(extras.join("\\\n"));
  return lines.join("\n").trim();
}

/** The subscription's name, while it follows its source. */
function sourceTitle(spec: SourceSpec, cast?: Cast | null, account?: { handle: string | null; displayName: string | null; fid: number } | null): string {
  if (spec.kind === "channel") return `/${spec.channel.id} on Farcaster`;
  const who = account ?? cast;
  return who ? `${authorLabel(who)} on Farcaster` : `fid ${spec.fid} on Farcaster`;
}

function sourceOrigin(spec: SourceSpec, handle: string | null): string {
  if (spec.kind === "channel") return `https://farcaster.xyz/~/channel/${spec.channel.id}`;
  return handle ? `https://farcaster.xyz/${encodeURIComponent(handle)}` : `https://farcaster.xyz/~/profiles/${spec.fid}`;
}

export interface AddSourceInput {
  kind: "account" | "channel";
  /** An account: an FID or a handle (with or without @). A channel: its id. */
  value: string;
  /** A channel's parent URL, which the hub backend needs. */
  parent_url?: string;
}

/** Create the subscription for one source. Throws FarcasterError for bad input or an unknown account. */
export async function addFarcasterSource(env: FarcasterEnv, input: AddSourceInput, source?: CastSource): Promise<{ sub: SubscriptionRow; existing: boolean }> {
  const value = input.value.trim().replace(/^[@/]/, "");
  let spec: SourceSpec;
  let title: string;
  let origin: string;
  if (input.kind === "account") {
    const settings = await getFarcasterSettings(env.DB);
    const src = source ?? castSource(env, settings);
    const asFid = /^\d+$/.test(value) ? Number(value) : null;
    const account = asFid !== null ? await src.account(asFid).catch((e) => (e instanceof FarcasterError && e.kind === "not_found" ? null : Promise.reject(e))) : await src.resolveAccount(value);
    const fid = account?.fid ?? (asFid !== null && isFid(asFid) ? asFid : null);
    if (!fid) throw new FarcasterError("not_found", `no Farcaster account named ${value}`);
    spec = { kind: "account", fid };
    title = sourceTitle(spec, null, account);
    origin = sourceOrigin(spec, account?.handle ?? null);
  } else {
    if (!/^[a-z0-9-]{1,64}$/i.test(value)) throw new FarcasterError("config", "a channel id is letters, digits and hyphens");
    const parentUrl = input.parent_url?.trim() || null;
    if (parentUrl && !isHttpUrl(parentUrl)) throw new FarcasterError("config", "a channel's parent URL must be an absolute http(s) URL");
    spec = { kind: "channel", channel: { id: value.toLowerCase(), parentUrl } };
    title = sourceTitle(spec);
    origin = sourceOrigin(spec, null);
  }
  const feedUrl = specToFeedUrl(spec);
  const existing = await findSubscription(env.DB, feedUrl, feedUrl);
  if (existing) return { sub: existing, existing: true };
  const sub = await createSubscription(env.DB, { kind: "farcaster", origin, feedUrl, title });
  return { sub, existing: false };
}

/** Keep the normalized cast, for stubbing and the thread sheet. */
export async function rememberCast(db: D1Database, cast: Cast): Promise<void> {
  await db
    .prepare("INSERT INTO farcaster_cast_cache (fid, hash, cast_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT (fid, hash) DO UPDATE SET cast_json = excluded.cast_json, fetched_at = excluded.fetched_at")
    .bind(cast.fid, cast.hash, JSON.stringify(cast), nowIso())
    .run();
}

export async function heldCast(db: D1Database, ref: CastRef): Promise<Cast | null> {
  const row = await db.prepare("SELECT cast_json FROM farcaster_cast_cache WHERE fid = ? AND hash = ?").bind(ref.fid, ref.hash).first<{ cast_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.cast_json) as Cast;
  } catch {
    return null;
  }
}

const POLL_LIMIT = 25;

export interface FarcasterPollResult {
  outcome: "polled" | "failed";
  itemsChanged: number;
}

/**
 * One poll of one Farcaster source. A backend error is recorded on the
 * subscription (its failure count, backoff and discrepancy log) and never
 * thrown: the rest of the reader carries on, as it does for a dead RSS feed.
 */
export async function pollFarcasterSubscription(db: D1Database, sub: SubscriptionRow, env: FarcasterEnv | undefined, source?: CastSource): Promise<FarcasterPollResult> {
  const spec = parseSourceSpec(sub.feed_url);
  const fail = async (detail: string): Promise<FarcasterPollResult> => {
    await recordPollFailure(db, sub.id);
    await appendFlag(db, sub.id, "farcaster-error", detail.slice(0, 200));
    return { outcome: "failed", itemsChanged: 0 };
  };
  if (!spec) return fail("this subscription's Farcaster source cannot be read");
  let page: Cast[];
  let template: string | undefined;
  try {
    const settings = await getFarcasterSettings(db);
    template = settings.cast_url_template;
    if (!source && !env) throw new FarcasterError("config", "no environment to read Farcaster with");
    const src = source ?? castSource(env!, settings);
    page = (spec.kind === "account" ? await src.accountCasts(spec.fid, { limit: POLL_LIMIT }) : await src.channelCasts(spec.channel, { limit: POLL_LIMIT })).casts;
  } catch (e) {
    return fail(e instanceof FarcasterError ? `${e.kind}: ${e.message}` : "the Farcaster backend failed");
  }
  if (spec.kind === "account") await refreshSourceTitle(db, sub.id, sourceTitle(spec, page[0] ?? null));
  const observedAt = nowIso();
  let changed = 0;
  for (const cast of page) {
    const remoteId = castRemoteId(cast);
    // A cast never changes after it is made, so one already held is done.
    if (await getImportedItem(db, sub.id, remoteId)) continue;
    const md = castMarkdown(cast, template);
    await upsertL0Item(db, sub.id, remoteId, {
      version: 1,
      created: cast.createdAt,
      updated: cast.createdAt,
      observedAt,
      contentMd: md,
      contentHtml: renderMarkdown(md),
      contentHash: await contentHash(md),
    });
    await rememberCast(db, cast);
    changed++;
  }
  await recordPollSuccess(db, sub.id, { newestGuid: page[0] ? castRemoteId(page[0]) : null });
  return { outcome: "polled", itemsChanged: changed };
}
