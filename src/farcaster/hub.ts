// The hub adapters: reading from, and submitting signed messages to, a
// Snapchain node's HTTP API (default port 3381). Reading needs no key. Writing
// needs the owner's own Ed25519 signer (see message.ts), so no API company
// holds the key that posts as the owner.
//
// Request and response shapes follow the Snapchain HTTP API as documented at
// docs.neynar.com/snapchain/httpapi and docs.farcaster.xyz/developers/guides/
// querying, read through @farcaster/core 0.21.0's protobuf JSON. NONE of it
// was exercised against a live node from the build sandbox; see
// docs/blygcaster-decisions.md, "Unverified against the real network".
//
// The protobuf JSON for bytes is base64 in @farcaster/core and `0x` hex in the
// hub HTTP API; normalizeHash accepts either, so a change between the two does
// not break reading.

import type { CastSink, CastDraft, AttemptIdentity } from "./sink.ts";
import type { CastSource } from "./source.ts";
import type { HttpFn } from "./http.ts";
import { buildUrl, requestJson } from "./http.ts";
import { castAddData, castRemoveData, ed25519Signer, signMessage } from "./message.ts";
import type { Ed25519Signer } from "./message.ts";
import {
  castWebUrl,
  clampLimit,
  cleanName,
  cleanText,
  dedupeEmbeds,
  fromFarcasterTime,
  isHttpUrl,
  looksLikeImage,
  newestFirst,
  normalizeHash,
  toFid,
  validCast,
} from "./normalize.ts";
import type { Cast, CastEmbed, CastPage, CastRef, ChannelRef, FarcasterAccount, PageOptions } from "./types.ts";
import { FarcasterError, isCastHash, isFid } from "./types.ts";

export interface HubOptions {
  /** Base URL of the node's HTTP API, e.g. https://hub.example.com:3381 */
  url: string;
  http: HttpFn;
  /** Sent as `x-api-key` when the node wants one (Neynar's hosted Snapchain API does). */
  apiKey?: string;
  castUrlTemplate?: string;
  timeoutMs?: number;
  /** Names already known for FIDs (config.ts keeps them in D1). */
  accountCache?: { get(fid: number): Promise<FarcasterAccount | null>; put(account: FarcasterAccount): Promise<void> };
}

const MAX_PAGE = 100;
const HOME_FEED_MAX_FIDS = 100;
const HOME_FEED_CONCURRENCY = 4;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

export class HubCastSource implements CastSource {
  readonly backend = "hub";
  private accounts = new Map<number, Promise<FarcasterAccount | null>>();
  constructor(private readonly options: HubOptions) {
    if (!isHttpUrl(options.url)) throw new FarcasterError("config", "the hub URL must be an absolute http(s) URL");
  }

  private get(path: string, query: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.options.apiKey) headers["x-api-key"] = this.options.apiKey;
    return requestJson(this.options.http, buildUrl(this.options.url, path, query), { headers }, this.options.timeoutMs);
  }

  /** `{messages, nextPageToken}` → normalized casts. Messages that are not CastAdds, or fail validation, are dropped. */
  private async page(body: unknown, topLevelOnly: boolean): Promise<CastPage> {
    const o = obj(body);
    if (!o || !Array.isArray(o.messages)) throw new FarcasterError("malformed", "hub response has no messages array");
    const casts: Cast[] = [];
    for (const m of o.messages) {
      const cast = await this.toCast(m);
      if (!cast) continue;
      if (topLevelOnly && cast.parentHash) continue;
      casts.push(cast);
    }
    const token = typeof o.nextPageToken === "string" && o.nextPageToken ? o.nextPageToken : null;
    return { casts, cursor: token };
  }

  private async toCast(raw: unknown): Promise<Cast | null> {
    const m = obj(raw);
    const data = obj(m?.data);
    if (!m || !data) return null;
    if (data.type !== "MESSAGE_TYPE_CAST_ADD" && data.type !== 1) return null;
    const body = obj(data.castAddBody);
    const fid = toFid(data.fid);
    const hash = normalizeHash(m.hash);
    const text = cleanText(body?.text ?? "");
    if (!body || !fid || !hash || text === null || typeof data.timestamp !== "number") return null;
    const account = await this.account(fid).catch(() => null);
    const parent = obj(body.parentCastId);
    const parentHash = parent ? normalizeHash(parent.hash) : null;
    const parentFid = parent ? toFid(parent.fid) : null;
    const parentUrl = isHttpUrl(body.parentUrl) ? body.parentUrl : null;
    const embeds: CastEmbed[] = [];
    for (const e of Array.isArray(body.embeds) ? body.embeds : []) {
      const eo = obj(e);
      if (!eo) continue;
      if (isHttpUrl(eo.url)) embeds.push({ type: looksLikeImage(eo.url) ? "image" : "link", url: eo.url });
      const cid = obj(eo.castId);
      const ch = cid ? normalizeHash(cid.hash) : null;
      const cf = cid ? toFid(cid.fid) : null;
      if (ch && cf) embeds.push({ type: "cast", cast: { fid: cf, hash: ch } });
    }
    const cast: Cast = {
      fid,
      hash,
      handle: account?.handle ?? null,
      displayName: account?.displayName ?? null,
      text: await this.withMentions(text, body),
      createdAt: fromFarcasterTime(data.timestamp),
      url: castWebUrl({ fid, hash, handle: account?.handle ?? null }, this.options.castUrlTemplate),
      parentHash,
      parentFid: parentHash ? parentFid : null,
      parentUrl,
      embeds: dedupeEmbeds(embeds),
      channel: parentUrl,
    };
    return validCast(cast) ? cast : null;
  }

  /**
   * A hub stores a cast's text with its @mentions cut out, and their FIDs and
   * UTF-8 byte positions beside it. Put the handles back, so the text reads
   * as its author wrote it. An FID with no handle reads `@fid:N`.
   */
  private async withMentions(text: string, body: Json): Promise<string> {
    const fids = Array.isArray(body.mentions) ? body.mentions.map(toFid) : [];
    const positions = Array.isArray(body.mentionsPositions) ? body.mentionsPositions : [];
    if (!fids.length || fids.length !== positions.length) return text;
    const bytes = new TextEncoder().encode(text);
    const decoder = new TextDecoder();
    let out = "";
    let at = 0;
    for (let i = 0; i < fids.length; i++) {
      const pos = positions[i];
      const fid = fids[i];
      if (typeof pos !== "number" || !Number.isInteger(pos) || pos < at || pos > bytes.length || !fid) return text;
      const account = await this.account(fid).catch(() => null);
      out += decoder.decode(bytes.slice(at, pos)) + "@" + (account?.handle ?? `fid:${fid}`);
      at = pos;
    }
    return out + decoder.decode(bytes.slice(at));
  }

  async homeFeed(fids: number[], options: PageOptions = {}): Promise<CastPage> {
    const wanted = [...new Set(fids.filter(isFid))].slice(0, HOME_FEED_MAX_FIDS);
    const limit = clampLimit(options.limit, MAX_PAGE);
    const pages: CastPage[] = [];
    // A hub has no merged feed: read each account's newest casts and merge.
    // The cursor is not offered here; the merged view is the newest `limit`.
    for (let i = 0; i < wanted.length; i += HOME_FEED_CONCURRENCY) {
      pages.push(...(await Promise.all(wanted.slice(i, i + HOME_FEED_CONCURRENCY).map((fid) => this.accountCasts(fid, { limit })))));
    }
    return { casts: pages.flatMap((p) => p.casts).sort(newestFirst).slice(0, limit), cursor: null };
  }

  async accountCasts(fid: number, options: PageOptions = {}): Promise<CastPage> {
    if (!isFid(fid)) throw new FarcasterError("config", "an account is a positive FID");
    const body = await this.get("v1/castsByFid", { fid, pageSize: clampLimit(options.limit, MAX_PAGE), reverse: true, pageToken: options.cursor ?? undefined });
    return this.page(body, true);
  }

  async channelCasts(channel: ChannelRef, options: PageOptions = {}): Promise<CastPage> {
    // A hub knows a channel only by its parent URL; the id-to-URL registry
    // lives off the protocol. The owner enters the URL with the channel.
    if (!isHttpUrl(channel.parentUrl)) throw new FarcasterError("unsupported", `the hub backend needs channel ${channel.id}'s parent URL`);
    const body = await this.get("v1/castsByParent", { url: channel.parentUrl, pageSize: clampLimit(options.limit, MAX_PAGE), reverse: true, pageToken: options.cursor ?? undefined });
    const page = await this.page(body, false);
    return { ...page, casts: page.casts.map((c) => ({ ...c, channel: channel.id || c.channel })) };
  }

  async cast(ref: CastRef | { url: string }): Promise<Cast | null> {
    if (!("hash" in ref)) throw new FarcasterError("unsupported", "the hub backend looks casts up by FID and hash, not by URL");
    if (!isFid(ref.fid) || !isCastHash(ref.hash)) throw new FarcasterError("config", "a cast is an FID and a 0x hash");
    try {
      return await this.toCast(await this.get("v1/castById", { fid: ref.fid, hash: ref.hash }));
    } catch (e) {
      if (e instanceof FarcasterError && e.kind === "not_found") return null;
      throw e;
    }
  }

  async replies(ref: CastRef, options: PageOptions = {}): Promise<CastPage> {
    const body = await this.get("v1/castsByParent", { fid: ref.fid, hash: ref.hash, pageSize: clampLimit(options.limit, MAX_PAGE), pageToken: options.cursor ?? undefined });
    const page = await this.page(body, false);
    return { ...page, casts: page.casts.sort((a, b) => -newestFirst(a, b)) };
  }

  account(fid: number): Promise<FarcasterAccount | null> {
    // One lookup per FID per adapter instance: a poll builds its own adapter,
    // so a channel full of one author's casts costs one request, not twenty.
    let cached = this.accounts.get(fid);
    if (!cached) {
      cached = this.fetchAccount(fid);
      this.accounts.set(fid, cached);
    }
    return cached;
  }

  private async fetchAccount(fid: number): Promise<FarcasterAccount | null> {
    const cached = await this.options.accountCache?.get(fid).catch(() => null);
    if (cached) return cached;
    const body = obj(await this.get("v1/userDataByFid", { fid }));
    if (!body || !Array.isArray(body.messages)) throw new FarcasterError("malformed", "hub userDataByFid has no messages array");
    let handle: string | null = null;
    let displayName: string | null = null;
    for (const m of body.messages) {
      const ud = obj(obj(obj(m)?.data)?.userDataBody);
      if (!ud) continue;
      if (ud.type === "USER_DATA_TYPE_USERNAME" || ud.type === 6) handle = cleanName(ud.value)?.replace(/^@/, "") ?? handle;
      if (ud.type === "USER_DATA_TYPE_DISPLAY" || ud.type === 2) displayName = cleanName(ud.value) ?? displayName;
    }
    const account = { fid, handle, displayName };
    await this.options.accountCache?.put(account).catch(() => {});
    return account;
  }

  async resolveAccount(handle: string): Promise<FarcasterAccount | null> {
    const name = handle.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-.]{0,63}$/.test(name)) return null;
    let body: Json | null;
    try {
      body = obj(await this.get("v1/userNameProofByName", { name }));
    } catch (e) {
      if (e instanceof FarcasterError && e.kind === "not_found") return null;
      throw e;
    }
    const fid = toFid(body?.fid);
    if (!fid) return null;
    return (await this.account(fid)) ?? { fid, handle: name, displayName: null };
  }
}

export interface HubSinkOptions extends HubOptions {
  /** The owner's FID, which the signer key is registered to. */
  fid: number;
  /** FARCASTER_SIGNER_KEY: the app signer's Ed25519 private key, hex. Never the custody key. */
  signerKey: string;
}

export class HubCastSink implements CastSink {
  readonly backend = "hub";
  private signer: Promise<Ed25519Signer> | null = null;
  constructor(private readonly options: HubSinkOptions) {
    if (!isHttpUrl(options.url)) throw new FarcasterError("config", "the hub URL must be an absolute http(s) URL");
    if (!isFid(options.fid)) throw new FarcasterError("config", "set your FID before cross-posting");
  }

  private getSigner(): Promise<Ed25519Signer> {
    this.signer ??= ed25519Signer(this.options.signerKey);
    return this.signer;
  }

  private async submit(bytes: Uint8Array): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream", Accept: "application/json" };
    if (this.options.apiKey) headers["x-api-key"] = this.options.apiKey;
    try {
      await requestJson(this.options.http, buildUrl(this.options.url, "v1/submitMessage"), { method: "POST", headers, body: bytes }, this.options.timeoutMs);
    } catch (e) {
      // A retry resubmits identical bytes. A node that already holds the
      // message says so, and the cast exists under the hash we computed.
      if (e instanceof FarcasterError && e.kind === "http" && /duplicate/i.test(e.message)) return;
      throw e;
    }
  }

  async post(draft: CastDraft, attempt: AttemptIdentity): Promise<{ hash: string }> {
    if (!draft.parent && draft.channel && !draft.channel.parentUrl) throw new FarcasterError("config", `the hub backend needs channel ${draft.channel.id}'s parent URL`);
    const signer = await this.getSigner();
    const data = castAddData(this.options.fid, attempt.timestamp, {
      text: draft.text,
      embeds: draft.embeds,
      parent: draft.parent,
      parentUrl: draft.parent ? undefined : (draft.channel?.parentUrl ?? undefined),
    });
    const message = await signMessage(data, signer);
    await this.submit(message.bytes);
    return { hash: message.hash };
  }

  async delete(hash: string, attempt: AttemptIdentity): Promise<void> {
    if (!isCastHash(hash)) throw new FarcasterError("config", "a cast hash is 0x and 40 hex digits");
    const signer = await this.getSigner();
    const message = await signMessage(castRemoveData(this.options.fid, attempt.timestamp, hash), signer);
    try {
      await this.submit(message.bytes);
    } catch (e) {
      // Deleting a cast the node no longer holds is the outcome we wanted.
      if (e instanceof FarcasterError && (e.kind === "not_found" || (e.kind === "http" && /not ?found|unknown/i.test(e.message)))) return;
      throw e;
    }
  }
}
