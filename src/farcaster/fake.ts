// In-memory adapters, for tests and for trying blygcaster locally without a
// network: `wrangler dev --var FARCASTER_FAKE:1` selects them (config.ts), and
// the test suite drives them directly. They never touch the network.

import type { AttemptIdentity, CastDraft, CastSink } from "./sink.ts";
import type { CastSource } from "./source.ts";
import { castWebUrl, newestFirst } from "./normalize.ts";
import type { Cast, CastPage, CastRef, ChannelRef, FarcasterAccount, PageOptions } from "./types.ts";
import { FarcasterError } from "./types.ts";

/** Fills in the fields a test rarely cares about. */
export function fakeCast(partial: Partial<Cast> & { fid: number; hash: string }): Cast {
  const handle = partial.handle === undefined ? `user${partial.fid}` : partial.handle;
  return {
    handle,
    displayName: partial.displayName === undefined ? `User ${partial.fid}` : partial.displayName,
    text: "",
    createdAt: "2026-10-01T12:00:00.000Z",
    url: castWebUrl({ fid: partial.fid, hash: partial.hash, handle }),
    parentHash: null,
    parentFid: null,
    parentUrl: null,
    embeds: [],
    channel: null,
    ...partial,
  };
}

/** A hash that is deterministic in `n`, for fixtures. */
export const fakeHash = (n: number): string => "0x" + n.toString(16).padStart(40, "0");

/**
 * A few casts for trying blygcaster locally with FARCASTER_FAKE=1: two
 * accounts, a channel, an image, a link, a reply and text that looks like
 * markdown. Invented accounts on invented FIDs; nothing here is anyone's.
 */
export function demoCasts(now = Date.now()): Cast[] {
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();
  return [
    fakeCast({ fid: 900001, hash: fakeHash(900001), handle: "riverkeeper", displayName: "River Keeper", createdAt: at(1), text: "The Colorado once reached the sea every year.\n\nNow most years it does not. What would it take to let it?", embeds: [{ type: "image", url: "https://picsum.photos/seed/canyon/640/400.jpg" }] }),
    fakeCast({ fid: 900001, hash: fakeHash(900002), handle: "riverkeeper", displayName: "River Keeper", createdAt: at(5), text: "# Not a heading, *not emphasis*, just a cast with https://example.com/a_link in it." }),
    fakeCast({ fid: 900001, hash: fakeHash(900003), handle: "riverkeeper", displayName: "River Keeper", createdAt: at(6), text: "Replying to myself.", parentHash: fakeHash(900002), parentFid: 900001 }),
    fakeCast({ fid: 900002, hash: fakeHash(900004), handle: "silt", displayName: "Silt and Stone", createdAt: at(2), text: "Granaries in the canyon walls held a season's harvest from the floodplain.", channel: "water", parentUrl: "https://farcaster.xyz/~/channel/water", embeds: [{ type: "link", url: "https://www.nps.gov/grca/learn/historyculture/index.htm" }] }),
  ];
}

export class FakeCastSource implements CastSource {
  readonly backend = "fake";
  casts: Cast[] = [];
  /** When set, every call throws it (or, for "hang", never settles). */
  failWith: FarcasterError | "hang" | null = null;

  constructor(casts: Cast[] = []) {
    this.casts = casts;
  }

  private async gate(): Promise<void> {
    if (this.failWith === "hang") await new Promise(() => {});
    if (this.failWith) throw this.failWith;
  }

  private page(casts: Cast[], options: PageOptions): CastPage {
    const limit = options.limit ?? 25;
    return { casts: casts.slice(0, limit), cursor: null };
  }

  async homeFeed(fids: number[], options: PageOptions = {}): Promise<CastPage> {
    await this.gate();
    return this.page(this.casts.filter((c) => fids.includes(c.fid) && !c.parentHash).sort(newestFirst), options);
  }
  async accountCasts(fid: number, options: PageOptions = {}): Promise<CastPage> {
    await this.gate();
    return this.page(this.casts.filter((c) => c.fid === fid && !c.parentHash).sort(newestFirst), options);
  }
  async channelCasts(channel: ChannelRef, options: PageOptions = {}): Promise<CastPage> {
    await this.gate();
    return this.page(this.casts.filter((c) => (c.channel === channel.id || (!!channel.parentUrl && c.parentUrl === channel.parentUrl)) && !c.parentHash).sort(newestFirst), options);
  }
  async cast(ref: CastRef | { url: string }): Promise<Cast | null> {
    await this.gate();
    return this.casts.find((c) => ("hash" in ref ? c.hash === ref.hash : c.url === ref.url)) ?? null;
  }
  async replies(ref: CastRef, options: PageOptions = {}): Promise<CastPage> {
    await this.gate();
    return this.page(this.casts.filter((c) => c.parentHash === ref.hash).sort((a, b) => -newestFirst(a, b)), options);
  }
  async account(fid: number): Promise<FarcasterAccount | null> {
    await this.gate();
    const c = this.casts.find((x) => x.fid === fid);
    return c ? { fid, handle: c.handle, displayName: c.displayName } : null;
  }
  async resolveAccount(handle: string): Promise<FarcasterAccount | null> {
    await this.gate();
    const c = this.casts.find((x) => x.handle === handle.replace(/^@/, ""));
    return c ? { fid: c.fid, handle: c.handle, displayName: c.displayName } : null;
  }
}

export interface FakeSinkCall {
  op: "post" | "delete";
  draft?: CastDraft;
  hash?: string;
  attempt: AttemptIdentity;
}

export class FakeCastSink implements CastSink {
  readonly backend = "fake";
  calls: FakeSinkCall[] = [];
  /** Casts that exist on the fake network, by hash. */
  live = new Map<string, CastDraft>();
  /** Fail the next N calls with this error (or hang them). */
  failures: Array<FarcasterError | "hang"> = [];
  /** Milliseconds every call waits before answering. */
  delayMs = 0;

  private async gate(): Promise<void> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const next = this.failures.shift();
    if (next === "hang") await new Promise(() => {});
    if (next) throw next;
  }

  async post(draft: CastDraft, attempt: AttemptIdentity): Promise<{ hash: string }> {
    this.calls.push({ op: "post", draft, attempt });
    await this.gate();
    // Deterministic in the attempt, as the hub sink is: a retry of the same
    // cast lands on the same hash and does not make a second cast.
    const hash = await fakeCastHash(attempt.idempotencyKey);
    this.live.set(hash, draft);
    return { hash };
  }

  async delete(hash: string, attempt: AttemptIdentity): Promise<void> {
    this.calls.push({ op: "delete", hash, attempt });
    await this.gate();
    this.live.delete(hash);
  }
}

async function fakeCastHash(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return "0x" + Array.from(digest.slice(0, 20), (b) => b.toString(16).padStart(2, "0")).join("");
}
