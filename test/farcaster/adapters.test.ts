// Phase 1 acceptance: normalization, error handling, and a backend that
// returns garbage or never answers. Every adapter is driven through an
// injected HttpFn; nothing here reaches the network.
import { describe, expect, it } from "vitest";
import type { HttpFn, HttpRequest } from "../../src/farcaster/http.ts";
import { requestJson } from "../../src/farcaster/http.ts";
import { HubCastSink, HubCastSource } from "../../src/farcaster/hub.ts";
import { NeynarCastSink, NeynarCastSource } from "../../src/farcaster/neynar.ts";
import { castWebUrl, normalizeHash } from "../../src/farcaster/normalize.ts";
import { FarcasterError } from "../../src/farcaster/types.ts";
import golden from "./fixtures/golden-messages.json";

const HASH = "0x" + "ab".repeat(20);
const HASH2 = "0x" + "cd".repeat(20);

interface Seen {
  url: string;
  request: HttpRequest;
}

/** An HttpFn that answers from a route table and records what it was asked. */
function fakeHttp(routes: Record<string, (url: URL, req: HttpRequest) => { status?: number; body: unknown }>) {
  const seen: Seen[] = [];
  const http: HttpFn = async (url, request = {}) => {
    seen.push({ url, request });
    const u = new URL(url);
    const route = routes[u.pathname];
    if (!route) return { status: 404, text: async () => '{"error":"no route"}' };
    const r = route(u, request);
    return { status: r.status ?? 200, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  return { http, seen };
}

const hubUserData = (fid: number, username: string, display: string) => ({
  messages: [
    { data: { type: "MESSAGE_TYPE_USER_DATA_ADD", fid, userDataBody: { type: "USER_DATA_TYPE_USERNAME", value: username } } },
    { data: { type: "MESSAGE_TYPE_USER_DATA_ADD", fid, userDataBody: { type: "USER_DATA_TYPE_DISPLAY", value: display } } },
    // A field blygcaster never shows, which must not leak into the shape.
    { data: { type: "MESSAGE_TYPE_USER_DATA_ADD", fid, userDataBody: { type: "USER_DATA_TYPE_BIO", value: "followers: 1,000,000" } } },
  ],
});

const hubCast = (fid: number, hash: string, text: string, extra: Record<string, unknown> = {}) => ({
  data: { type: "MESSAGE_TYPE_CAST_ADD", fid, timestamp: 150000000, network: "FARCASTER_NETWORK_MAINNET", castAddBody: { embedsDeprecated: [], mentions: [], mentionsPositions: [], text, embeds: [], ...extra } },
  hash,
  hashScheme: "HASH_SCHEME_BLAKE3",
});

describe("hub source normalization", () => {
  const { http, seen } = fakeHttp({
    "/v1/castsByFid": () => ({
      body: {
        messages: [
          hubCast(3, HASH, "hello  world", { embeds: [{ url: "https://imagedelivery.net/abc/original" }, { url: "https://example.com/post" }, { castId: { fid: 2, hash: HASH2 } }] }),
          // A reply: dropped from an account's top-level feed.
          hubCast(3, HASH2, "a reply", { parentCastId: { fid: 2, hash: HASH } }),
          // Not a cast at all.
          { data: { type: "MESSAGE_TYPE_REACTION_ADD", fid: 3, reactionBody: { type: "REACTION_TYPE_LIKE" } }, hash: HASH },
          // Garbage entries are dropped, not fatal.
          null,
          { data: { type: "MESSAGE_TYPE_CAST_ADD", fid: -1, timestamp: 1, castAddBody: { text: "bad fid" } }, hash: HASH },
          { data: { type: "MESSAGE_TYPE_CAST_ADD", fid: 3, timestamp: 1, castAddBody: { text: "bad hash" } }, hash: "0x1234" },
        ],
        nextPageToken: "tok",
      },
    }),
    "/v1/userDataByFid": (u) => ({ body: hubUserData(Number(u.searchParams.get("fid")), "dwr", "Dan Romero") }),
  });
  const source = new HubCastSource({ url: "https://hub.example.com:3381", http });

  it("produces the normalized shape and nothing else", async () => {
    const page = await source.accountCasts(3, { limit: 10 });
    expect(page.cursor).toBe("tok");
    expect(page.casts).toEqual([
      {
        fid: 3,
        hash: HASH,
        handle: "dwr",
        displayName: "Dan Romero",
        text: "hello  world",
        createdAt: "2025-10-03T02:40:00.000Z",
        url: `https://farcaster.xyz/dwr/${HASH.slice(0, 10)}`,
        parentHash: null,
        parentFid: null,
        parentUrl: null,
        embeds: [
          { type: "image", url: "https://imagedelivery.net/abc/original" },
          { type: "link", url: "https://example.com/post" },
          { type: "cast", cast: { fid: 2, hash: HASH2 } },
        ],
        channel: null,
      },
    ]);
    const castsCall = new URL(seen.find((s) => s.url.includes("castsByFid"))!.url);
    expect(Object.fromEntries(castsCall.searchParams)).toEqual({ fid: "3", pageSize: "10", reverse: "true" });
  });

  it("carries no metric anywhere in a normalized cast", async () => {
    const page = await source.accountCasts(3);
    expect(JSON.stringify(page)).not.toMatch(/count|like|recast|follower|score|reaction/i);
  });

  it("puts @mentions back at their byte positions", async () => {
    const { http } = fakeHttp({
      "/v1/castById": () => ({ body: hubCast(3, HASH, "héllo  and ", { mentions: [5, 6], mentionsPositions: [7, 12] }) }),
      "/v1/userDataByFid": (u) => ({ body: u.searchParams.get("fid") === "5" ? hubUserData(5, "alice", "Alice") : { messages: [] } }),
    });
    const cast = await new HubCastSource({ url: "https://hub.example.com", http }).cast({ fid: 3, hash: HASH });
    expect(cast?.text).toBe("héllo @alice and @fid:6");
  });

  it("asks for a channel's parent URL rather than guessing it", async () => {
    await expect(source.channelCasts({ id: "water" })).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("returns null for a cast the hub does not hold", async () => {
    const { http } = fakeHttp({});
    expect(await new HubCastSource({ url: "https://hub.example.com", http }).cast({ fid: 3, hash: HASH })).toBeNull();
  });
});

describe("Neynar source normalization", () => {
  const neynarCast = {
    object: "cast",
    hash: HASH,
    author: { object: "user", fid: 3, username: "dwr", display_name: "Dan Romero", follower_count: 999999, following_count: 1, score: 0.99 },
    text: "a cast with @alice",
    timestamp: "2026-10-28T09:30:00.000Z",
    embeds: [
      { url: "https://cdn.example.com/x", metadata: { _status: "200", content_type: "image/png" } },
      { url: "https://example.com/a" },
      { cast: { hash: HASH2, author: { fid: 7 } } },
    ],
    parent_hash: null,
    parent_url: "https://farcaster.xyz/~/channel/water",
    parent_author: { fid: null },
    channel: { object: "channel_dehydrated", id: "water", name: "Water" },
    reactions: { likes_count: 42, recasts_count: 7 },
    replies: { count: 3 },
  };
  const { http, seen } = fakeHttp({
    "/v2/farcaster/feed/user/casts/": () => ({ body: { casts: [neynarCast, { garbage: true }], next: { cursor: "c2" } } }),
    "/v2/farcaster/cast/": () => ({ body: { cast: neynarCast } }),
  });
  const source = new NeynarCastSource({ apiKey: "fake-neynar-key", http });

  it("produces the normalized shape and drops every count", async () => {
    const page = await source.accountCasts(3);
    expect(page.cursor).toBe("c2");
    expect(page.casts).toHaveLength(1);
    expect(page.casts[0]).toEqual({
      fid: 3,
      hash: HASH,
      handle: "dwr",
      displayName: "Dan Romero",
      text: "a cast with @alice",
      createdAt: "2026-10-28T09:30:00.000Z",
      url: `https://farcaster.xyz/dwr/${HASH.slice(0, 10)}`,
      parentHash: null,
      parentFid: null,
      parentUrl: "https://farcaster.xyz/~/channel/water",
      embeds: [
        { type: "image", url: "https://cdn.example.com/x" },
        { type: "link", url: "https://example.com/a" },
        { type: "cast", cast: { fid: 7, hash: HASH2 } },
      ],
      channel: "water",
    });
    expect(JSON.stringify(page)).not.toMatch(/count|like|recast|follower|score/i);
  });

  it("sends the key as a header, never in the URL", async () => {
    await source.cast({ hash: HASH, fid: 3 });
    const call = seen.at(-1)!;
    expect(call.url).not.toContain("fake-neynar-key");
    expect(call.request.headers?.["x-api-key"]).toBe("fake-neynar-key");
    expect(new URL(call.url).searchParams.get("type")).toBe("hash");
  });

  it("refuses to start without its key", () => {
    expect(() => new NeynarCastSource({ apiKey: "", http })).toThrow(FarcasterError);
  });
});

describe("a backend that misbehaves", () => {
  const answering = (status: number, body: string): HttpFn => async () => ({ status, text: async () => body });

  it("maps HTTP statuses onto error kinds", async () => {
    await expect(requestJson(answering(401, "nope"), "https://x.example/")).rejects.toMatchObject({ kind: "auth", status: 401 });
    await expect(requestJson(answering(404, ""), "https://x.example/")).rejects.toMatchObject({ kind: "not_found" });
    await expect(requestJson(answering(429, ""), "https://x.example/")).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(requestJson(answering(503, ""), "https://x.example/")).rejects.toMatchObject({ kind: "http", status: 503, transient: true });
    await expect(requestJson(answering(400, "bad"), "https://x.example/")).rejects.toMatchObject({ kind: "http", transient: false });
  });

  it("treats a non-JSON body as malformed", async () => {
    await expect(requestJson(answering(200, "<html>oops</html>"), "https://x.example/")).rejects.toMatchObject({ kind: "malformed" });
  });

  it("treats JSON of the wrong shape as malformed, for both backends", async () => {
    const garbage = answering(200, JSON.stringify({ unexpected: [1, 2, 3] }));
    await expect(new HubCastSource({ url: "https://hub.example.com", http: garbage }).accountCasts(3)).rejects.toMatchObject({ kind: "malformed" });
    await expect(new NeynarCastSource({ apiKey: "k", http: garbage }).accountCasts(3)).rejects.toMatchObject({ kind: "malformed" });
    const arrays = answering(200, JSON.stringify([]));
    await expect(new HubCastSource({ url: "https://hub.example.com", http: arrays }).accountCasts(3)).rejects.toMatchObject({ kind: "malformed" });
  });

  it("keeps the good casts when some entries are garbage", async () => {
    const { http } = fakeHttp({
      "/v2/farcaster/feed/user/casts/": () => ({ body: { casts: [7, "x", null, { hash: "nope" }, { hash: HASH, author: { fid: 3 }, text: "ok", timestamp: "2026-10-01T00:00:00Z", embeds: "not-an-array" }], next: null } }),
    });
    const page = await new NeynarCastSource({ apiKey: "k", http }).accountCasts(3);
    expect(page.casts.map((c) => c.text)).toEqual(["ok"]);
    expect(page.cursor).toBeNull();
  });

  it("times out a backend that never answers", async () => {
    const hang: HttpFn = () => new Promise(() => {});
    const started = Date.now();
    await expect(new HubCastSource({ url: "https://hub.example.com", http: hang, timeoutMs: 50 }).accountCasts(3)).rejects.toMatchObject({ kind: "timeout", transient: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("times out a body that never finishes", async () => {
    const slowBody: HttpFn = async () => ({ status: 200, text: () => new Promise<string>(() => {}) });
    await expect(requestJson(slowBody, "https://x.example/", {}, 50)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("reports a thrown fetch as a network error", async () => {
    const down: HttpFn = async () => {
      throw new TypeError("connection refused");
    };
    await expect(requestJson(down, "https://x.example/")).rejects.toMatchObject({ kind: "network", transient: true });
  });

  it("refuses a hub URL that is not http(s)", () => {
    expect(() => new HubCastSource({ url: "file:///etc/passwd", http: answering(200, "{}") })).toThrow(FarcasterError);
  });
});

describe("hub sink", () => {
  const at = new Date("2025-10-03T02:40:00.000Z");

  it("submits the signed protobuf and returns the hash it computed", async () => {
    const { http, seen } = fakeHttp({ "/v1/submitMessage": () => ({ body: { hash: golden.castAdds[0].hash } }) });
    const sink = new HubCastSink({ url: "https://hub.example.com", http, fid: golden.dataOptions.fid, signerKey: golden.privateKey });
    const out = await sink.post({ text: golden.castAdds[0].input.text, embeds: golden.castAdds[0].input.embeds }, { timestamp: at, idempotencyKey: "k1" });
    expect(out.hash).toBe(golden.castAdds[0].hash);
    const call = seen[0];
    expect(call.request.method).toBe("POST");
    expect(call.request.headers?.["Content-Type"]).toBe("application/octet-stream");
    const body = call.request.body as Uint8Array;
    expect("0x" + Array.from(body, (b) => b.toString(16).padStart(2, "0")).join("")).toBe(golden.castAdds[0].message);
  });

  it("treats a duplicate as success, so a retry after a lost answer does not fail", async () => {
    const { http } = fakeHttp({ "/v1/submitMessage": () => ({ status: 400, body: { errCode: "bad_request.duplicate", message: "message has already been merged" } }) });
    const sink = new HubCastSink({ url: "https://hub.example.com", http, fid: 424242, signerKey: golden.privateKey });
    await expect(sink.post({ text: "x", embeds: [] }, { timestamp: at, idempotencyKey: "k" })).resolves.toMatchObject({ hash: expect.stringMatching(/^0x[0-9a-f]{40}$/) });
  });

  it("needs an FID and a parent URL for a channel", async () => {
    const { http } = fakeHttp({});
    expect(() => new HubCastSink({ url: "https://hub.example.com", http, fid: 0, signerKey: golden.privateKey })).toThrow("set your FID");
    const sink = new HubCastSink({ url: "https://hub.example.com", http, fid: 1, signerKey: golden.privateKey });
    await expect(sink.post({ text: "x", embeds: [], channel: { id: "water" } }, { timestamp: at, idempotencyKey: "k" })).rejects.toMatchObject({ kind: "config" });
  });

  it("deletes with a signed CastRemove", async () => {
    const { http, seen } = fakeHttp({ "/v1/submitMessage": () => ({ body: {} }) });
    const sink = new HubCastSink({ url: "https://hub.example.com", http, fid: golden.dataOptions.fid, signerKey: golden.privateKey });
    await sink.delete(golden.castRemoves[0].input.targetHash, { timestamp: at, idempotencyKey: "d" });
    const body = seen[0].request.body as Uint8Array;
    expect("0x" + Array.from(body, (b) => b.toString(16).padStart(2, "0")).join("")).toBe(golden.castRemoves[0].message);
  });
});

describe("Neynar sink", () => {
  it("posts with the signer UUID and an idempotency key, and reads back the hash", async () => {
    const { http, seen } = fakeHttp({ "/v2/farcaster/cast/": () => ({ body: { success: true, cast: { hash: HASH, author: { fid: 9 }, text: "x" } } }) });
    const sink = new NeynarCastSink({ apiKey: "k", signerUuid: "fake-signer-uuid", http });
    const out = await sink.post({ text: "hi", embeds: ["https://blyg.example/f/1/"], channel: { id: "water" } }, { timestamp: new Date(), idempotencyKey: "idem-1" });
    expect(out.hash).toBe(HASH);
    expect(JSON.parse(seen[0].request.body as string)).toEqual({ signer_uuid: "fake-signer-uuid", text: "hi", embeds: [{ url: "https://blyg.example/f/1/" }], idem: "idem-1", channel_id: "water" });
  });

  it("treats a missing cast as already deleted", async () => {
    const { http } = fakeHttp({ "/v2/farcaster/cast/": () => ({ status: 404, body: { message: "not found" } }) });
    await expect(new NeynarCastSink({ apiKey: "k", signerUuid: "s", http }).delete(HASH)).resolves.toBeUndefined();
  });
});

describe("display URLs", () => {
  it("is a template, with a fallback when the handle is unknown", () => {
    expect(castWebUrl({ fid: 3, hash: HASH, handle: "dwr" })).toBe(`https://farcaster.xyz/dwr/${HASH.slice(0, 10)}`);
    expect(castWebUrl({ fid: 3, hash: HASH, handle: null })).toBe(`https://farcaster.xyz/~/conversations/${HASH}`);
    expect(castWebUrl({ fid: 3, hash: HASH, handle: "dwr" }, "https://nsp.example/c/{fid}/{hash}")).toBe(`https://nsp.example/c/3/${HASH}`);
    expect(castWebUrl({ fid: 3, hash: HASH, handle: "dwr" }, "javascript:alert(1)")).toBe(`https://farcaster.xyz/~/conversations/${HASH}`);
  });

  it("normalizes hashes from hex or base64", () => {
    expect(normalizeHash("0X" + "AB".repeat(20))).toBe(HASH);
    expect(normalizeHash("ab".repeat(20))).toBe(HASH);
    expect(normalizeHash(btoa(String.fromCharCode(...Array(20).fill(0xab))))).toBe(HASH);
    expect(normalizeHash("0x12")).toBeNull();
    expect(normalizeHash(42)).toBeNull();
  });
});
