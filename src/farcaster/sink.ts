// CastSink: the only way blygcaster writes to Farcaster, from the owner's own
// account and nowhere else (brief §5, §7). Adapters: hub.ts (the owner's own
// Ed25519 signer, submitted to any Snapchain node), neynar.ts (a Neynar
// managed signer) and fake.ts.
//
// Both operations must be safe to retry with the same `attempt` values: the
// hub sink signs a deterministic message from the fixed timestamp, so a retry
// resubmits identical bytes and gets the same hash, and the Neynar sink sends
// the same idempotency key.

import type { CastRef, ChannelRef } from "./types.ts";

export interface CastDraft {
  text: string;
  /** Absolute http(s) URLs. A Farcaster cast holds at most 4 embeds. */
  embeds: string[];
  /** Reply to this cast. */
  parent?: CastRef;
  /** Post into this channel. Ignored when `parent` is set. */
  channel?: ChannelRef;
}

export interface AttemptIdentity {
  /** Fixed for every attempt at one cast: the hub sink signs with it, so retries are byte-identical. */
  timestamp: Date;
  /** Fixed for every attempt at one cast: the Neynar sink sends it as `idem`. */
  idempotencyKey: string;
}

export interface CastSink {
  readonly backend: string;
  /** Post a cast and return its hash. Throws FarcasterError. */
  post(draft: CastDraft, attempt: AttemptIdentity): Promise<{ hash: string }>;
  /** Delete one of the owner's own casts. Deleting a cast that is already gone succeeds. Throws FarcasterError. */
  delete(hash: string, attempt: AttemptIdentity): Promise<void>;
}

/** Plain casts carry at most 320 bytes of UTF-8 text (validated by @farcaster/core 0.21.0). */
export const CAST_TEXT_MAX_BYTES = 320;
export const CAST_EMBEDS_MAX = 4;
