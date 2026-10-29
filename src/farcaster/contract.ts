// blygcaster's owner routes under /api/farcaster/, declared like every other
// operation so they reach openapi.json, the SDK and MCP with the same scopes.
// Spread into `routes` in src/contract/routes.ts (one line, listed in
// docs/blygcaster-hooks.md). Reads are owner:read; settings and sources are
// owner:manage; anything that casts is owner:publish (permissions.ts).
//
// Studio-private, all of it: none of these shapes reaches the wire.

import { z } from "@hono/zod-openapi";
import { route } from "../contract/route.ts";
import { SubscriptionSchema } from "../contract/resources.ts";

const backend = z.enum(["hub", "neynar"]);

export const FarcasterSettingsSchema = z
  .object({
    fid: z.number().int().positive().nullable().describe("The owner's FID: the account cross-posts are cast from."),
    read_backend: backend,
    write_backend: backend,
    hub_url: z.string().describe("A Snapchain node's HTTP API, e.g. https://hub.example.com:3381. Empty until set."),
    cast_url_template: z.string().describe("How a cast's web page is built: {handle}, {fid}, {hash}, {shortHash}. Display only."),
    crosspost_enabled: z.boolean().describe("The kill switch. False: nothing is cast or deleted."),
    crosspost_channel_id: z.string().describe("Every cross-post goes to this channel; empty for none."),
    crosspost_channel_parent_url: z.string().describe("The channel's parent URL, which the hub backend needs."),
    ai_note: z.string().describe("Appended to a cast whose item discloses generated text."),
  })
  .openapi("FarcasterSettings");

export const FarcasterStatusSchema = z
  .object({
    settings: FarcasterSettingsSchema,
    secrets: z.object({ FARCASTER_SIGNER_KEY: z.boolean(), FARCASTER_HUB_API_KEY: z.boolean(), NEYNAR_API_KEY: z.boolean(), NEYNAR_SIGNER_UUID: z.boolean() }).describe("Whether each Worker secret is set. Never a value."),
    fake: z.boolean().describe("The in-memory fake backend is selected (FARCASTER_FAKE=1, local development only)."),
  })
  .openapi("FarcasterStatus");

const castRef = z.object({ fid: z.number().int().positive(), hash: z.string() });
export const CastSchema = z
  .object({
    fid: z.number().int().positive(),
    hash: z.string(),
    handle: z.string().nullable(),
    displayName: z.string().nullable(),
    text: z.string(),
    createdAt: z.string(),
    url: z.string(),
    parentHash: z.string().nullable(),
    parentFid: z.number().int().nullable(),
    parentUrl: z.string().nullable(),
    embeds: z.array(z.union([z.object({ type: z.literal("image"), url: z.string() }), z.object({ type: z.literal("link"), url: z.string() }), z.object({ type: z.literal("cast"), cast: castRef })])),
    channel: z.string().nullable(),
  })
  .openapi("FarcasterCast");

export const CastRecordSchema = z
  .object({
    id: z.string(),
    item_id: z.string(),
    version: z.number().int(),
    purpose: z.enum(["crosspost", "reply"]),
    status: z.enum(["pending", "posted", "failed", "cancelled", "deleting", "deleted", "skipped", "delete_failed"]),
    cast_hash: z.string().nullable(),
    cast_url: z.string().nullable().describe("The cast's web page, from the URL template. Display only."),
    text: z.string().describe("What was, or will be, cast."),
    attempts: z.number().int(),
    next_attempt_at: z.string().nullable(),
    last_error: z.string().nullable(),
    backend: z.string().nullable(),
    created: z.string(),
    updated: z.string(),
  })
  .openapi("FarcasterCastRecord");

export const FarcasterItemSchema = z
  .object({
    enabled: z.boolean().describe("This item is cross-posted when published. Off by default."),
    stub: z.object({ fid: z.number().int(), hash: z.string(), url: z.string() }).nullable().describe("The cast this item stubs, when it was made from one."),
    can_reply: z.boolean().describe("The reply offer applies: a published stub of a cast with no reply recorded."),
    records: z.array(CastRecordSchema),
  })
  .openapi("FarcasterItem");

const stubMarker = z.object({ fid: z.number().int(), hash: z.string(), item_id: z.string(), status: z.enum(["draft", "public", "withdrawn"]) });

export const farcasterRoutes = {
  getFarcasterSettings: route("getFarcasterSettings", "get", "/farcaster/settings", FarcasterStatusSchema),
  updateFarcasterSettings: route("updateFarcasterSettings", "patch", "/farcaster/settings", FarcasterStatusSchema, FarcasterSettingsSchema.partial()),
  addFarcasterSource: route(
    "addFarcasterSource",
    "post",
    "/farcaster/sources",
    SubscriptionSchema,
    z.object({
      kind: z.enum(["account", "channel"]),
      value: z.string().trim().min(1).max(100).describe("An account: its FID or @handle. A channel: its id."),
      parent_url: z.string().optional().describe("A channel's parent URL, which the hub backend needs."),
    }),
    201,
  ),
  getFarcasterThread: route(
    "getFarcasterThread",
    "get",
    "/farcaster/thread",
    z.object({ cast: z.union([CastSchema, z.null()]), parents: z.array(CastSchema), replies: z.array(CastSchema), error: z.string().optional().describe("Part of the thread could not be read; what is here is what could.") }),
    undefined,
    200,
    z.object({ fid: z.coerce.number().int().positive(), hash: z.string().regex(/^0x[0-9a-f]{40}$/) }),
  ),
  listFarcasterStubs: route(
    "listFarcasterStubs",
    "get",
    "/farcaster/stubs",
    z.object({ items: z.array(stubMarker) }),
    undefined,
    200,
    z.object({ casts: z.string().max(4000).describe("Comma-separated fid:hash pairs.") }),
  ),
  listFarcasterCasts: route("listFarcasterCasts", "get", "/farcaster/casts", z.object({ items: z.array(CastRecordSchema), total: z.number().int(), offset: z.number().int(), limit: z.number().int() }), undefined, 200, z.object({ offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).optional() })),
  getFarcasterItem: route("getFarcasterItem", "get", "/farcaster/items/{id}", FarcasterItemSchema),
  setFarcasterCrosspost: route("setFarcasterCrosspost", "put", "/farcaster/items/{id}/crosspost", FarcasterItemSchema, z.object({ enabled: z.boolean() })),
  replyOnFarcaster: route("replyOnFarcaster", "post", "/farcaster/items/{id}/reply", FarcasterItemSchema, undefined, 201),
};

/** Operations that write to Farcaster: owner:publish, like publishing itself. */
export const FARCASTER_PUBLISH_OPERATIONS = ["setFarcasterCrosspost", "replyOnFarcaster"];
