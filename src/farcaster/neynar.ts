// The Neynar adapters: Neynar's v2 REST API at https://api.neynar.com, with
// the API key (a Worker secret) sent as `x-api-key`. Posting goes through a
// Neynar managed signer, named by its `signer_uuid` (also a secret), which
// Neynar holds; that is why the hub sink is the default (docs/blygcaster-
// decisions.md, Q20).
//
// Shapes are from @neynar/nodejs-sdk 3.177.0 (2026-10-26), which is generated
// from Neynar's OpenAPI definition: `Cast`, `User`, `Embed`, `FeedResponse`,
// `PostCastReqBody`, `DeleteCastReqBody`. None of it was exercised against
// the live API from the build sandbox.
//
// Neynar returns reaction counts, follower counts and scores. Normalization
// drops every one of them.

import type { AttemptIdentity, CastDraft, CastSink } from "./sink.ts";
import type { CastSource } from "./source.ts";
import type { HttpFn } from "./http.ts";
import { buildUrl, requestJson } from "./http.ts";
import { castWebUrl, clampLimit, cleanName, cleanText, dedupeEmbeds, isHttpUrl, looksLikeImage, normalizeHash, toFid, validCast } from "./normalize.ts";
import type { Cast, CastEmbed, CastPage, CastRef, ChannelRef, FarcasterAccount, PageOptions } from "./types.ts";
import { FarcasterError, isCastHash, isFid } from "./types.ts";

export const NEYNAR_API = "https://api.neynar.com";

export interface NeynarOptions {
  apiKey: string;
  http: HttpFn;
  baseUrl?: string;
  castUrlTemplate?: string;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

function requireKey(key: string | undefined, name: string): string {
  if (!key || !key.trim()) throw new FarcasterError("config", `${name} is not set`);
  return key.trim();
}

function toAccount(raw: unknown): FarcasterAccount | null {
  const u = obj(raw);
  const fid = toFid(u?.fid);
  if (!u || !fid) return null;
  return { fid, handle: cleanName(u.username)?.replace(/^@/, "") ?? null, displayName: cleanName(u.display_name) };
}

export function normalizeNeynarCast(raw: unknown, template?: string): Cast | null {
  const c = obj(raw);
  if (!c) return null;
  const author = toAccount(c.author);
  const hash = normalizeHash(c.hash);
  const text = cleanText(c.text ?? "");
  if (!author || !hash || text === null || typeof c.timestamp !== "string") return null;
  const createdAt = new Date(c.timestamp);
  if (Number.isNaN(createdAt.getTime())) return null;
  const embeds: CastEmbed[] = [];
  for (const e of Array.isArray(c.embeds) ? c.embeds : []) {
    const eo = obj(e);
    if (!eo) continue;
    if (isHttpUrl(eo.url)) {
      const contentType = obj(eo.metadata)?.content_type;
      embeds.push({ type: looksLikeImage(eo.url, typeof contentType === "string" ? contentType : null) ? "image" : "link", url: eo.url });
    }
    const embedded = obj(eo.cast) ?? obj(eo.cast_id);
    const eh = embedded ? normalizeHash(embedded.hash) : null;
    const ef = embedded ? (toFid(obj(embedded.author)?.fid) ?? toFid(embedded.fid)) : null;
    if (eh && ef) embeds.push({ type: "cast", cast: { fid: ef, hash: eh } });
  }
  const channel = obj(c.channel);
  const parentHash = normalizeHash(c.parent_hash);
  const cast: Cast = {
    fid: author.fid,
    hash,
    handle: author.handle,
    displayName: author.displayName,
    text,
    createdAt: createdAt.toISOString(),
    url: castWebUrl({ fid: author.fid, hash, handle: author.handle }, template),
    parentHash,
    parentFid: parentHash ? toFid(obj(c.parent_author)?.fid) : null,
    parentUrl: isHttpUrl(c.parent_url) ? c.parent_url : null,
    embeds: dedupeEmbeds(embeds),
    channel: typeof channel?.id === "string" && channel.id ? channel.id : isHttpUrl(c.parent_url) ? c.parent_url : null,
  };
  return validCast(cast) ? cast : null;
}

export class NeynarCastSource implements CastSource {
  readonly backend = "neynar";
  private readonly key: string;
  constructor(private readonly options: NeynarOptions) {
    this.key = requireKey(options.apiKey, "NEYNAR_API_KEY");
  }

  private get(path: string, query: Record<string, string | number | boolean | undefined | null>): Promise<unknown> {
    return requestJson(this.options.http, buildUrl(this.options.baseUrl ?? NEYNAR_API, path, query), { headers: { "x-api-key": this.key, Accept: "application/json" } }, this.options.timeoutMs);
  }

  private feed(body: unknown, topLevelOnly: boolean): CastPage {
    const o = obj(body);
    if (!o || !Array.isArray(o.casts)) throw new FarcasterError("malformed", "Neynar feed response has no casts array");
    const casts = o.casts.map((c) => normalizeNeynarCast(c, this.options.castUrlTemplate)).filter((c): c is Cast => !!c && !(topLevelOnly && c.parentHash));
    const cursor = obj(o.next)?.cursor;
    return { casts, cursor: typeof cursor === "string" && cursor ? cursor : null };
  }

  async homeFeed(fids: number[], options: PageOptions = {}): Promise<CastPage> {
    const wanted = [...new Set(fids.filter(isFid))].slice(0, 100);
    if (!wanted.length) return { casts: [], cursor: null };
    const body = await this.get("v2/farcaster/feed/", {
      feed_type: "filter",
      filter_type: "fids",
      fids: wanted.join(","),
      with_recasts: false,
      limit: clampLimit(options.limit, 100),
      cursor: options.cursor,
    });
    return this.feed(body, true);
  }

  async accountCasts(fid: number, options: PageOptions = {}): Promise<CastPage> {
    if (!isFid(fid)) throw new FarcasterError("config", "an account is a positive FID");
    const body = await this.get("v2/farcaster/feed/user/casts/", { fid, include_replies: false, limit: clampLimit(options.limit, 150), cursor: options.cursor });
    return this.feed(body, true);
  }

  async channelCasts(channel: ChannelRef, options: PageOptions = {}): Promise<CastPage> {
    if (!/^[a-z0-9-]{1,64}$/i.test(channel.id)) throw new FarcasterError("config", "a channel id is letters, digits and hyphens");
    const body = await this.get("v2/farcaster/feed/channels/", {
      channel_ids: channel.id,
      with_recasts: false,
      with_replies: false,
      members_only: false,
      limit: clampLimit(options.limit, 100),
      cursor: options.cursor,
    });
    return this.feed(body, true);
  }

  async cast(ref: CastRef | { url: string }): Promise<Cast | null> {
    const query = "hash" in ref ? { identifier: ref.hash, type: "hash" } : { identifier: ref.url, type: "url" };
    if ("hash" in ref && !isCastHash(ref.hash)) throw new FarcasterError("config", "a cast hash is 0x and 40 hex digits");
    if (!("hash" in ref) && !isHttpUrl(ref.url)) throw new FarcasterError("config", "a cast URL must be absolute http(s)");
    try {
      const body = obj(await this.get("v2/farcaster/cast/", query));
      if (!body || !("cast" in body)) throw new FarcasterError("malformed", "Neynar cast response has no cast");
      return normalizeNeynarCast(body.cast, this.options.castUrlTemplate);
    } catch (e) {
      if (e instanceof FarcasterError && e.kind === "not_found") return null;
      throw e;
    }
  }

  async replies(ref: CastRef, options: PageOptions = {}): Promise<CastPage> {
    const body = obj(
      await this.get("v2/farcaster/cast/conversation/", {
        identifier: ref.hash,
        type: "hash",
        reply_depth: 1,
        include_chronological_parent_casts: false,
        sort_type: "chron",
        limit: clampLimit(options.limit, 50, 20),
        cursor: options.cursor,
      }),
    );
    const cast = obj(obj(body?.conversation)?.cast);
    if (!cast || !Array.isArray(cast.direct_replies)) throw new FarcasterError("malformed", "Neynar conversation response has no direct_replies");
    const casts = cast.direct_replies.map((c) => normalizeNeynarCast(c, this.options.castUrlTemplate)).filter((c): c is Cast => !!c);
    const cursor = obj(body?.next)?.cursor;
    return { casts, cursor: typeof cursor === "string" && cursor ? cursor : null };
  }

  async account(fid: number): Promise<FarcasterAccount | null> {
    const body = obj(await this.get("v2/farcaster/user/bulk/", { fids: String(fid) }));
    if (!body || !Array.isArray(body.users)) throw new FarcasterError("malformed", "Neynar user response has no users array");
    return toAccount(body.users[0]);
  }

  async resolveAccount(handle: string): Promise<FarcasterAccount | null> {
    const username = handle.trim().replace(/^@/, "");
    if (!/^[a-z0-9][a-z0-9-.]{0,63}$/i.test(username)) return null;
    try {
      const body = obj(await this.get("v2/farcaster/user/by_username/", { username }));
      return toAccount(body?.user);
    } catch (e) {
      if (e instanceof FarcasterError && e.kind === "not_found") return null;
      throw e;
    }
  }
}

export interface NeynarSinkOptions extends NeynarOptions {
  /** NEYNAR_SIGNER_UUID: the managed signer, approved by the owner's account. */
  signerUuid: string;
}

export class NeynarCastSink implements CastSink {
  readonly backend = "neynar";
  private readonly key: string;
  private readonly signer: string;
  constructor(private readonly options: NeynarSinkOptions) {
    this.key = requireKey(options.apiKey, "NEYNAR_API_KEY");
    this.signer = requireKey(options.signerUuid, "NEYNAR_SIGNER_UUID");
  }

  private send(method: "POST" | "DELETE", body: Json): Promise<unknown> {
    return requestJson(
      this.options.http,
      buildUrl(this.options.baseUrl ?? NEYNAR_API, "v2/farcaster/cast/"),
      { method, headers: { "x-api-key": this.key, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) },
      this.options.timeoutMs,
    );
  }

  async post(draft: CastDraft, attempt: AttemptIdentity): Promise<{ hash: string }> {
    const body: Json = {
      signer_uuid: this.signer,
      text: draft.text,
      embeds: draft.embeds.map((url) => ({ url })),
      idem: attempt.idempotencyKey,
    };
    if (draft.parent) {
      body.parent = draft.parent.hash;
      body.parent_author_fid = draft.parent.fid;
    } else if (draft.channel) {
      body.channel_id = draft.channel.id;
    }
    const res = obj(await this.send("POST", body));
    const hash = normalizeHash(obj(res?.cast)?.hash);
    if (!hash) throw new FarcasterError("malformed", "Neynar did not return the new cast's hash");
    return { hash };
  }

  async delete(hash: string): Promise<void> {
    if (!isCastHash(hash)) throw new FarcasterError("config", "a cast hash is 0x and 40 hex digits");
    try {
      await this.send("DELETE", { signer_uuid: this.signer, target_hash: hash });
    } catch (e) {
      if (e instanceof FarcasterError && e.kind === "not_found") return;
      throw e;
    }
  }
}
