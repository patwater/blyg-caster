// The normalized Farcaster shapes every backend is reduced to (brief §5).
//
// A cast's identity is its author's FID and its hash. Everything else here is
// display: the web URL in particular is derived from a template, because the
// web domain has already changed once (warpcast.com → farcaster.xyz) and the
// protocol changed hands twice in 2026.
//
// There are deliberately no likes, recasts, reply counts or follower counts in
// any of these shapes. blygcaster does not show metrics, so the adapters never
// carry them past normalization.

/** A cast's identity. `hash` is `0x` + 40 lowercase hex digits. */
export interface CastRef {
  fid: number;
  hash: string;
}

export type CastEmbed =
  | { type: "image"; url: string }
  | { type: "link"; url: string }
  | { type: "cast"; cast: CastRef };

export interface Cast {
  fid: number;
  hash: string;
  /** Username without the `@`, or null when the backend did not say. */
  handle: string | null;
  displayName: string | null;
  text: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** A web page for the cast. Display only, never identity. */
  url: string;
  parentHash: string | null;
  /** The parent cast's author, when the backend says (the hub always does). */
  parentFid: number | null;
  /** A parent URL that is not a cast, such as a channel's. */
  parentUrl: string | null;
  embeds: CastEmbed[];
  /** Channel id when known (Neynar), else the channel's parent URL (hub), else null. */
  channel: string | null;
}

export interface CastPage {
  casts: Cast[];
  cursor: string | null;
}

export interface PageOptions {
  limit?: number;
  cursor?: string | null;
}

/** A channel is addressed by id (Neynar) or by its parent URL (hub). */
export interface ChannelRef {
  id: string;
  parentUrl?: string | null;
}

export interface FarcasterAccount {
  fid: number;
  handle: string | null;
  displayName: string | null;
}

export type FarcasterErrorKind =
  | "config" // a setting or secret is missing or invalid
  | "network" // the request did not complete
  | "timeout"
  | "auth" // 401/403
  | "not_found"
  | "rate_limited"
  | "http" // any other non-2xx
  | "malformed" // the backend answered with something that is not the documented shape
  | "unsupported"; // this backend cannot do that

export class FarcasterError extends Error {
  readonly kind: FarcasterErrorKind;
  readonly status?: number;
  constructor(kind: FarcasterErrorKind, message: string, status?: number) {
    super(message);
    this.name = "FarcasterError";
    this.kind = kind;
    this.status = status;
  }
  /** Worth retrying later: the backend may answer next time. */
  get transient(): boolean {
    return this.kind === "network" || this.kind === "timeout" || this.kind === "rate_limited" || (this.kind === "http" && (this.status ?? 0) >= 500);
  }
}

export const isCastHash = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-f]{40}$/.test(s);
export const isFid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
