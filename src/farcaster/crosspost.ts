// Cross-posting (brief §5–§6, phase 4).
//
// Spec §15.2's outbound rules, applied to Farcaster: delivery is fire and
// forget. A publish or a withdrawal records what Farcaster should see and
// tries once under waitUntil; it never waits for Farcaster and never fails
// because of it. A failed attempt is retried at 15 minutes, 1 hour, 4 hours,
// 12 hours and 24 hours by the quarter-hour cron, then abandoned. The status of
// every cast is recorded in farcaster_casts, studio-private, and shown in the
// editor and on the Farcaster page. It is information, never a publish outcome.
//
// The rules the brief sets, and where they hold:
//   - Off by default per item: nothing is cast without a farcaster_optin row.
//   - Only from the owner's own account: the one CastSink config.ts builds.
//   - A pin never re-casts: pinning is not publishing, and nothing here hooks it.
//   - A republish that changes nothing does not re-cast: same draft, no cast.
//   - A republish that changes the words deletes the old cast and casts the
//     new version (Q14).
//   - A withdrawal deletes the cast, and the reply (Q15).
//   - The kill switch in Settings stops every write to Farcaster at once.

import { getItem, getVersion } from "../model.ts";
import { nowIso } from "../util.ts";
import { castSink, getFarcasterSettings } from "./config.ts";
import type { FarcasterEnv, FarcasterSettings } from "./config.ts";
import { composeCrosspost, composeReply, ownWords } from "./compose.ts";
import type { CastDraft, CastSink } from "./sink.ts";
import { castStubFor } from "./stub.ts";
import { FarcasterError } from "./types.ts";

export const RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000, 4 * 3600_000, 12 * 3600_000, 24 * 3600_000];
/** How long one attempt may hold a record before another worker may take it. */
const LEASE_MS = 5 * 60_000;
/** One sink call may take this long; then it counts as a timed-out attempt. */
const SINK_TIMEOUT_MS = 30_000;
const DRAIN_BATCH = 20;

export type CastStatus = "pending" | "posted" | "failed" | "cancelled" | "deleting" | "deleted" | "skipped" | "delete_failed";

export interface CastRecord {
  id: string;
  item_id: string;
  version: number;
  purpose: "crosspost" | "reply";
  cast_hash: string | null;
  status: CastStatus;
  attempts: number;
  next_attempt_at: string | null;
  attempt_at: string;
  last_error: string | null;
  draft_json: string;
  backend: string | null;
  created: string;
  updated: string;
}

export interface Deps {
  /** Tests pass a fake; production builds the configured sink. */
  sink?: CastSink;
  now?: () => Date;
}

const clock = (deps: Deps) => deps.now ?? (() => new Date());

export async function isOptedIn(db: D1Database, itemId: string): Promise<boolean> {
  const row = await db.prepare("SELECT enabled FROM farcaster_optin WHERE item_id = ?").bind(itemId).first<{ enabled: number }>();
  return row?.enabled === 1;
}

export async function setOptIn(db: D1Database, itemId: string, enabled: boolean): Promise<void> {
  await db
    .prepare("INSERT INTO farcaster_optin (item_id, enabled, updated) VALUES (?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET enabled = excluded.enabled, updated = excluded.updated")
    .bind(itemId, enabled ? 1 : 0, nowIso())
    .run();
}

export async function recordsFor(db: D1Database, itemId: string): Promise<CastRecord[]> {
  return (await db.prepare("SELECT * FROM farcaster_casts WHERE item_id = ? ORDER BY created DESC, version DESC").bind(itemId).all<CastRecord>()).results;
}

export async function listRecords(db: D1Database, limit = 50, offset = 0): Promise<{ items: CastRecord[]; total: number }> {
  const total = (await db.prepare("SELECT COUNT(*) AS n FROM farcaster_casts").first<{ n: number }>())?.n ?? 0;
  const items = (await db.prepare("SELECT * FROM farcaster_casts ORDER BY updated DESC LIMIT ? OFFSET ?").bind(limit, offset).all<CastRecord>()).results;
  return { items, total };
}

/** The live cast for an item, if it has one: what a permalink page may link to (Q19). */
export async function liveCrosspost(db: D1Database, itemId: string): Promise<CastRecord | null> {
  return db.prepare("SELECT * FROM farcaster_casts WHERE item_id = ? AND purpose = 'crosspost' AND status = 'posted' AND cast_hash IS NOT NULL ORDER BY version DESC LIMIT 1").bind(itemId).first<CastRecord>();
}

const permalink = (origin: string, kind: string, id: string) => `${origin}${kind === "thread" ? "t" : "f"}/${id}/`;

function sameDraft(a: string, b: CastDraft): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(b);
  } catch {
    return false;
  }
}

async function insertRecord(db: D1Database, row: { itemId: string; version: number; purpose: "crosspost" | "reply"; status: "pending" | "skipped"; draft: CastDraft; now: Date; error?: string }): Promise<CastRecord | null> {
  const at = row.now.toISOString();
  return db
    .prepare(
      `INSERT INTO farcaster_casts (id, item_id, version, purpose, status, attempts, next_attempt_at, attempt_at, last_error, draft_json, created, updated)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (item_id, version, purpose) DO NOTHING RETURNING *`,
    )
    .bind(crypto.randomUUID(), row.itemId, row.version, row.purpose, row.status, row.status === "pending" ? at : null, at, row.error ?? null, JSON.stringify(row.draft), at, at)
    .first<CastRecord>();
}

/**
 * Retire an item's earlier casts: a posted one is queued for deletion, one not
 * yet posted is cancelled. `except` keeps the record just made.
 */
async function retire(db: D1Database, itemId: string, now: Date, purposes: Array<"crosspost" | "reply">, except?: string): Promise<void> {
  const at = now.toISOString();
  const marks = purposes.map(() => "?").join(", ");
  await db.batch([
    db
      .prepare(`UPDATE farcaster_casts SET status = 'deleting', attempts = 0, next_attempt_at = ?, attempt_at = ?, last_error = NULL, updated = ? WHERE item_id = ? AND status = 'posted' AND purpose IN (${marks}) AND id != ?`)
      .bind(at, at, at, itemId, ...purposes, except ?? ""),
    db.prepare(`UPDATE farcaster_casts SET status = 'cancelled', next_attempt_at = NULL, updated = ? WHERE item_id = ? AND status = 'pending' AND purpose IN (${marks}) AND id != ?`).bind(at, itemId, ...purposes, except ?? ""),
  ]);
}

/**
 * After a version is published. Records what to cast, retires the earlier
 * cast when the words changed, and tries once. Never throws: a publish that
 * has happened is not undone by anything here.
 */
export async function onPublished(env: FarcasterEnv, input: { itemId: string; version: number; origin: string }, deps: Deps = {}): Promise<void> {
  try {
    const db = env.DB;
    if (!(await isOptedIn(db, input.itemId))) return;
    const item = await getItem(db, input.itemId);
    const version = await getVersion(db, input.itemId, input.version);
    if (!item || !version || item.status !== "public" || !version.content_html) return;
    const settings = await getFarcasterSettings(db);
    const kind = item.kind === "thread" ? "thread" : "fragment";
    const generated = !!version.generated_json && version.generated_json !== "[]" && version.generated_json !== "null";
    const draft = composeCrosspost({ kind, html: version.content_html, url: permalink(input.origin, kind, item.id), generated }, settings);
    // A republish whose cast would read the same is not a new cast.
    const current = await db
      .prepare("SELECT * FROM farcaster_casts WHERE item_id = ? AND purpose = 'crosspost' AND status IN ('pending', 'posted') ORDER BY version DESC LIMIT 1")
      .bind(item.id)
      .first<CastRecord>();
    if (current && sameDraft(current.draft_json, draft)) return;
    const now = clock(deps)();
    if (!settings.crosspost_enabled) {
      await insertRecord(db, { itemId: item.id, version: input.version, purpose: "crosspost", status: "skipped", draft, now, error: "cross-posting was switched off in Settings" });
      return;
    }
    const record = await insertRecord(db, { itemId: item.id, version: input.version, purpose: "crosspost", status: "pending", draft, now });
    if (!record) return;
    await retire(db, item.id, now, ["crosspost"], record.id);
    await processItem(env, item.id, deps, settings);
  } catch (e) {
    console.error("farcaster: after-publish bookkeeping failed", e instanceof Error ? e.message : e);
  }
}

/** After a withdrawal: delete the item's casts, the reply included (Q15). Never throws. */
export async function onWithdrawn(env: FarcasterEnv, itemId: string, deps: Deps = {}): Promise<void> {
  try {
    await retire(env.DB, itemId, clock(deps)(), ["crosspost", "reply"]);
    await processItem(env, itemId, deps);
  } catch (e) {
    console.error("farcaster: after-withdraw bookkeeping failed", e instanceof Error ? e.message : e);
  }
}

export class ReplyRefused extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
  }
}

/**
 * The owner's one-tap reply to a stubbed cast, with a link to the stub (Q16).
 * Offered, never automatic: only this, called from the owner's own action,
 * makes a reply. Returns the record; the attempt runs in the background.
 */
export async function requestReply(env: FarcasterEnv, input: { itemId: string; origin: string }, deps: Deps = {}): Promise<{ record: CastRecord; attempt: Promise<void> }> {
  const db = env.DB;
  const item = await getItem(db, input.itemId);
  const stub = await castStubFor(db, input.itemId);
  if (!item || !stub) throw new ReplyRefused("this item is not a stub of a Farcaster cast", 404);
  if (item.status !== "public") throw new ReplyRefused("publish the stub first; the reply links to it", 409);
  const settings = await getFarcasterSettings(db);
  if (!settings.crosspost_enabled) throw new ReplyRefused("cross-posting is switched off in Settings → Farcaster", 409);
  const existing = await db.prepare("SELECT * FROM farcaster_casts WHERE item_id = ? AND purpose = 'reply' AND status IN ('pending', 'posted', 'deleting')").bind(item.id).first<CastRecord>();
  if (existing) throw new ReplyRefused("a reply to this cast is already recorded", 409);
  const version = await getVersion(db, item.id, item.version);
  const words = ownWords(version?.content_md ?? item.content_md);
  const draft = composeReply(words, permalink(input.origin, "thread", item.id), { fid: stub.fid, hash: stub.hash });
  const record = await insertRecord(db, { itemId: item.id, version: item.version, purpose: "reply", status: "pending", draft, now: clock(deps)() });
  if (!record) throw new ReplyRefused("a reply for this version is already recorded", 409);
  return { record, attempt: processItem(env, item.id, deps, settings).catch(() => {}) };
}

/** The quarter-hour cron: every record whose retry is due. */
export async function drainCasts(env: FarcasterEnv, deps: Deps = {}): Promise<number> {
  const settings = await getFarcasterSettings(env.DB);
  if (!settings.crosspost_enabled) return 0;
  const now = clock(deps)().toISOString();
  const due = (await env.DB.prepare("SELECT * FROM farcaster_casts WHERE status IN ('pending', 'deleting') AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?").bind(now, DRAIN_BATCH).all<CastRecord>()).results;
  for (const record of due) await processRecord(env, record, deps, settings);
  return due.length;
}

async function processItem(env: FarcasterEnv, itemId: string, deps: Deps, settings?: FarcasterSettings): Promise<void> {
  const s = settings ?? (await getFarcasterSettings(env.DB));
  if (!s.crosspost_enabled) return;
  const now = clock(deps)().toISOString();
  const due = (await env.DB.prepare("SELECT * FROM farcaster_casts WHERE item_id = ? AND status IN ('pending', 'deleting') AND next_attempt_at <= ? ORDER BY created").bind(itemId, now).all<CastRecord>()).results;
  for (const record of due) await processRecord(env, record, deps, s);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new FarcasterError("timeout", `no answer within ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(timer));
}

const describe = (e: unknown): string => (e instanceof FarcasterError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : "unknown error").slice(0, 300);

async function processRecord(env: FarcasterEnv, record: CastRecord, deps: Deps, settings: FarcasterSettings): Promise<void> {
  const db = env.DB;
  const now = clock(deps)();
  const at = now.toISOString();
  // Claim: one worker per record per lease, so the cron and a publish's own
  // attempt cannot post the same cast twice at once.
  const claimed = await db
    .prepare("UPDATE farcaster_casts SET next_attempt_at = ?, updated = ? WHERE id = ? AND status = ? AND next_attempt_at <= ? RETURNING *")
    .bind(new Date(now.getTime() + LEASE_MS).toISOString(), at, record.id, record.status, at)
    .first<CastRecord>();
  if (!claimed) return;
  let sink: CastSink;
  try {
    sink = deps.sink ?? castSink(env, settings);
  } catch (e) {
    await failed(db, claimed, e, now);
    return;
  }
  if (claimed.status === "pending") {
    let hash: string;
    try {
      const draft = JSON.parse(claimed.draft_json) as CastDraft;
      ({ hash } = await withTimeout(sink.post(draft, { timestamp: new Date(claimed.attempt_at), idempotencyKey: claimed.id }), SINK_TIMEOUT_MS));
    } catch (e) {
      await failed(db, claimed, e, now);
      return;
    }
    // Withdrawn or superseded while the cast was in flight: it is live now,
    // and it must go, so it moves straight to deletion.
    const done = clock(deps)().toISOString();
    const after = await db
      .prepare(
        `UPDATE farcaster_casts SET cast_hash = ?, backend = ?, last_error = NULL, updated = ?,
           status = CASE status WHEN 'pending' THEN 'posted' ELSE 'deleting' END,
           attempts = CASE status WHEN 'pending' THEN attempts + 1 ELSE 0 END,
           next_attempt_at = CASE status WHEN 'pending' THEN NULL ELSE ? END,
           attempt_at = CASE status WHEN 'pending' THEN attempt_at ELSE ? END
         WHERE id = ? RETURNING *`,
      )
      .bind(hash, sink.backend, done, done, done, claimed.id)
      .first<CastRecord>();
    if (after?.status === "deleting") await processRecord(env, after, deps, settings);
    return;
  }
  if (claimed.status === "deleting" && claimed.cast_hash) {
    try {
      await withTimeout(sink.delete(claimed.cast_hash, { timestamp: new Date(claimed.attempt_at), idempotencyKey: `${claimed.id}:delete` }), SINK_TIMEOUT_MS);
    } catch (e) {
      await failed(db, claimed, e, now);
      return;
    }
    await db.prepare("UPDATE farcaster_casts SET status = 'deleted', next_attempt_at = NULL, last_error = NULL, updated = ? WHERE id = ?").bind(clock(deps)().toISOString(), claimed.id).run();
  }
}

/** Record a failed attempt: schedule the next retry, or give up after the last one. */
async function failed(db: D1Database, record: CastRecord, error: unknown, now: Date): Promise<void> {
  const attempts = record.attempts + 1;
  const delay = RETRY_DELAYS_MS[attempts - 1];
  const giveUp = delay === undefined;
  const status = giveUp ? (record.status === "deleting" ? "delete_failed" : "failed") : record.status;
  console.warn("farcaster: cast attempt failed", record.id, describe(error));
  await db
    .prepare("UPDATE farcaster_casts SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ?, updated = ? WHERE id = ? AND status = ?")
    .bind(attempts, status, giveUp ? null : new Date(now.getTime() + delay).toISOString(), describe(error), now.toISOString(), record.id, record.status)
    .run();
}
