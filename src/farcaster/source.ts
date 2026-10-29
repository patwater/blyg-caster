// CastSource: everything blygcaster reads from Farcaster, behind one interface
// so that a backend can be swapped in Settings when an API's owner, terms or
// URL changes (brief §4). Adapters: hub.ts (Snapchain HTTP API, no key needed
// for reading), neynar.ts (Neynar v2 API, key as a Worker secret) and fake.ts.
//
// Every method either returns normalized casts or throws a FarcasterError. A
// backend that answers with a shape it did not document throws `malformed`;
// one cast that fails validation is dropped from its page and the rest are kept.

import type { Cast, CastPage, CastRef, ChannelRef, FarcasterAccount, PageOptions } from "./types.ts";

export type { Cast, CastEmbed, CastPage, CastRef, ChannelRef, FarcasterAccount, PageOptions } from "./types.ts";

export interface CastSource {
  readonly backend: string;
  /** Newest first, merged across up to 100 FIDs. Top-level casts only. */
  homeFeed(fids: number[], options?: PageOptions): Promise<CastPage>;
  /** One account's casts, newest first. Top-level casts only. */
  accountCasts(fid: number, options?: PageOptions): Promise<CastPage>;
  /** A channel's top-level casts, newest first. */
  channelCasts(channel: ChannelRef, options?: PageOptions): Promise<CastPage>;
  /** One cast by identity, or by a web URL where the backend can resolve one. Null when it does not exist. */
  cast(ref: CastRef | { url: string }): Promise<Cast | null>;
  /** Direct replies to a cast, oldest first. */
  replies(ref: CastRef, options?: PageOptions): Promise<CastPage>;
  /** Name and handle for an FID, or null when the FID has none. */
  account(fid: number): Promise<FarcasterAccount | null>;
  /** An account by its username, without the `@`. */
  resolveAccount(handle: string): Promise<FarcasterAccount | null>;
}
