// Handlers for blygcaster's /api/farcaster/ routes (contract.ts). Mounted in
// owner-api.ts behind the same session, token, scope and budget middleware as
// every other owner route.

import type { Context } from "hono";
import { contractApp, readJson } from "../contract/app.ts";
import { subscriptionResource } from "../contract/resources.ts";
import { getItem, getSettings } from "../model.ts";
import { siteOrigin } from "../protocol.ts";
import type { Env } from "../types.ts";
import { normalizeMount } from "../util.ts";
import { pollFarcasterSubscription } from "./reading.ts";
import { addFarcasterSource, heldCast } from "./reading.ts";
import type { AddSourceInput } from "./reading.ts";
import { castSource, getFarcasterSettings, putFarcasterSettings, secretStatus, settingsProblem } from "./config.ts";
import type { FarcasterEnv, FarcasterSettings } from "./config.ts";
import { farcasterRoutes } from "./contract.ts";
import { isOptedIn, listRecords, recordsFor, ReplyRefused, requestReply, setOptIn } from "./crosspost.ts";
import type { CastRecord } from "./crosspost.ts";
import { castWebUrl } from "./normalize.ts";
import { castStubFor } from "./stub.ts";
import type { Cast } from "./types.ts";
import { FarcasterError, isCastHash, isFid } from "./types.ts";

export const farcasterApi = contractApp();

const fenv = (c: Context<{ Bindings: Env }>) => c.env as FarcasterEnv;

async function status(env: FarcasterEnv, settings?: FarcasterSettings) {
  return { settings: settings ?? (await getFarcasterSettings(env.DB)), secrets: secretStatus(env), fake: env.FARCASTER_FAKE === "1" };
}

/** A record as the API shows it: the draft's text, and the cast's web page when it has one. */
async function recordResource(db: D1Database, settings: FarcasterSettings, r: CastRecord) {
  let text = "";
  try {
    text = (JSON.parse(r.draft_json) as { text?: string }).text ?? "";
  } catch {
    // An unreadable draft is shown as empty rather than failing the list.
  }
  let castUrl: string | null = null;
  if (r.cast_hash && settings.fid) {
    const own = await db.prepare("SELECT handle FROM farcaster_accounts WHERE fid = ?").bind(settings.fid).first<{ handle: string | null }>();
    castUrl = castWebUrl({ fid: settings.fid, hash: r.cast_hash, handle: own?.handle ?? null }, settings.cast_url_template);
  }
  return { id: r.id, item_id: r.item_id, version: r.version, purpose: r.purpose, status: r.status, cast_hash: r.cast_hash, cast_url: castUrl, text, attempts: r.attempts, next_attempt_at: r.next_attempt_at, last_error: r.last_error, backend: r.backend, created: r.created, updated: r.updated };
}

async function itemResource(env: FarcasterEnv, itemId: string) {
  const db = env.DB;
  const settings = await getFarcasterSettings(db);
  const [enabled, stub, records, item] = await Promise.all([isOptedIn(db, itemId), castStubFor(db, itemId), recordsFor(db, itemId), getItem(db, itemId)]);
  const replied = records.some((r) => r.purpose === "reply" && ["pending", "posted", "deleting"].includes(r.status));
  return {
    enabled,
    stub: stub ? { fid: stub.fid, hash: stub.hash, url: stub.cast_url } : null,
    can_reply: !!stub && item?.status === "public" && !replied && settings.crosspost_enabled,
    records: await Promise.all(records.map((r) => recordResource(db, settings, r))),
  };
}

const origin = async (c: Context<{ Bindings: Env }>) => siteOrigin(await getSettings(c.env.DB), c.req.url, normalizeMount(c.env.MOUNT));

const errorStatus = (e: FarcasterError): 400 | 404 | 502 => (e.kind === "config" || e.kind === "unsupported" ? 400 : e.kind === "not_found" ? 404 : 502);

farcasterApi.openapi(farcasterRoutes.getFarcasterSettings, async (c) => c.json(await status(fenv(c))));

farcasterApi.openapi(farcasterRoutes.updateFarcasterSettings, async (c) => {
  const patch = await readJson<Partial<FarcasterSettings>>(c);
  const problem = settingsProblem(patch);
  if (problem) return c.json({ error: problem }, 400);
  return c.json(await status(fenv(c), await putFarcasterSettings(c.env.DB, patch)));
});

farcasterApi.openapi(farcasterRoutes.addFarcasterSource, async (c) => {
  const body = await readJson<AddSourceInput>(c);
  try {
    const { sub, existing } = await addFarcasterSource(fenv(c), body);
    if (existing) return c.json({ error: `already subscribed: ${sub.title}` }, 409);
    // The first poll runs now, in the background, as subscribing to a feed does.
    c.executionCtx.waitUntil(pollFarcasterSubscription(c.env.DB, sub, fenv(c)).catch(() => {}));
    c.header("Location", `/api/subscriptions/${sub.id}`);
    return c.json(subscriptionResource(sub), 201);
  } catch (e) {
    if (e instanceof FarcasterError) return c.json({ error: e.message }, errorStatus(e));
    throw e;
  }
});

/**
 * The "view thread" sheet (Q3): the cast, up to five parents, and its direct
 * replies. Reads the network on demand; whatever fails comes back as `error`
 * beside whatever could be read, so the sheet always has something to show.
 */
farcasterApi.openapi(farcasterRoutes.getFarcasterThread, async (c) => {
  // Validated by the contract's query schema before this runs.
  const fid = Number(c.req.query("fid"));
  const hash = String(c.req.query("hash"));
  const settings = await getFarcasterSettings(c.env.DB);
  const ref = { fid, hash };
  let cast: Cast | null = await heldCast(c.env.DB, ref);
  const parents: Cast[] = [];
  let replies: Cast[] = [];
  const errors: string[] = [];
  let source;
  try {
    source = castSource(fenv(c), settings);
  } catch (e) {
    return c.json({ cast, parents, replies, error: e instanceof FarcasterError ? e.message : "the Farcaster backend is not configured" }, 200);
  }
  try {
    cast ??= await source.cast(ref);
  } catch (e) {
    errors.push(e instanceof FarcasterError ? e.message : "the cast could not be read");
  }
  let at = cast;
  for (let depth = 0; at?.parentHash && depth < 5; depth++) {
    try {
      const parent: Cast | null = at.parentFid ? await source.cast({ fid: at.parentFid, hash: at.parentHash }) : null;
      if (!parent) break;
      parents.unshift(parent);
      at = parent;
    } catch (e) {
      errors.push(e instanceof FarcasterError ? e.message : "a parent could not be read");
      break;
    }
  }
  try {
    replies = (await source.replies(ref, { limit: 25 })).casts;
  } catch (e) {
    errors.push(e instanceof FarcasterError ? e.message : "replies could not be read");
  }
  return c.json({ cast, parents, replies, ...(errors.length ? { error: errors.join("; ") } : {}) }, 200);
});

/** The stubbed marker (Q10): which of these casts the owner has stubbed, and with what item. */
farcasterApi.openapi(farcasterRoutes.listFarcasterStubs, async (c) => {
  const pairs = String(c.req.query("casts") ?? "")
    .split(",")
    .map((p) => p.trim().split(":"))
    .map(([f, h]) => ({ fid: Number(f), hash: h?.toLowerCase() }))
    .filter((p) => isFid(p.fid) && isCastHash(p.hash))
    .slice(0, 100);
  if (!pairs.length) return c.json({ items: [] }, 200);
  const where = pairs.map(() => "(s.fid = ? AND s.hash = ?)").join(" OR ");
  const rows = (
    await c.env.DB.prepare(`SELECT s.fid AS fid, s.hash AS hash, s.item_id AS item_id, i.status AS status FROM farcaster_stubs s JOIN items i ON i.id = s.item_id WHERE ${where} ORDER BY s.created DESC`)
      .bind(...pairs.flatMap((p) => [p.fid, p.hash]))
      .all<{ fid: number; hash: string; item_id: string; status: "draft" | "public" | "withdrawn" }>()
  ).results;
  return c.json({ items: rows }, 200);
});

farcasterApi.openapi(farcasterRoutes.listFarcasterCasts, async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const settings = await getFarcasterSettings(c.env.DB);
  const { items, total } = await listRecords(c.env.DB, limit, offset);
  return c.json({ items: await Promise.all(items.map((r) => recordResource(c.env.DB, settings, r))), total, offset, limit }, 200);
});

farcasterApi.openapi(farcasterRoutes.getFarcasterItem, async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  return c.json(await itemResource(fenv(c), item.id), 200);
});

farcasterApi.openapi(farcasterRoutes.setFarcasterCrosspost, async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const { enabled } = await readJson<{ enabled: boolean }>(c);
  // The toggle decides future publishes only. Turning it on does not cast a
  // version already published, and turning it off does not delete a cast.
  await setOptIn(c.env.DB, item.id, enabled);
  return c.json(await itemResource(fenv(c), item.id), 200);
});

farcasterApi.openapi(farcasterRoutes.replyOnFarcaster, async (c) => {
  try {
    const { attempt } = await requestReply(fenv(c), { itemId: c.req.param("id"), origin: await origin(c) });
    c.executionCtx.waitUntil(attempt);
  } catch (e) {
    if (e instanceof ReplyRefused) return c.json({ error: e.message }, e.status);
    throw e;
  }
  return c.json(await itemResource(fenv(c), c.req.param("id")), 201);
});
