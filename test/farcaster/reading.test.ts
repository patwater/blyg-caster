// Phase 2 acceptance: Farcaster sources in the reading view. Casts show text,
// author and time, interleaved with blog entries as ordinary L0 entries; a
// backend error leaves the rest of the reader working; and no metric reaches
// the reader. Driven through the real API with a fake CastSource.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { overrideAdapters } from "../../src/farcaster/config.ts";
import { FakeCastSource, fakeCast, fakeHash } from "../../src/farcaster/fake.ts";
import { castMarkdown, escapeCastText, parseCastRemoteId, parseSourceSpec, specToFeedUrl } from "../../src/farcaster/reading.ts";
import { FarcasterError } from "../../src/farcaster/types.ts";
import { runScheduledPoll } from "../../src/importer/schedule.ts";
import { createSubscription, upsertL0Item } from "../../src/importer/store.ts";
import { renderMarkdown } from "../../src/markdown.ts";
import { apiJson, getPublic, login } from "../helpers.ts";

afterEach(() => overrideAdapters(null));

const later = Date.parse("2030-01-01T00:00:00Z");

describe("a Farcaster source in the reader", () => {
  it("imports casts as reading entries with text, author and time, and no metrics", async () => {
    const cookie = await login();
    const source = new FakeCastSource([
      fakeCast({ fid: 3, hash: fakeHash(1), handle: "dwr", displayName: "Dan Romero", text: "Water is a commons.\nSecond line.", createdAt: "2026-10-27T10:00:00.000Z", embeds: [{ type: "image", url: "https://imagedelivery.net/x/y/original" }, { type: "link", url: "https://example.com/article" }] }),
      fakeCast({ fid: 3, hash: fakeHash(2), handle: "dwr", displayName: "Dan Romero", text: "An older cast", createdAt: "2026-10-20T10:00:00.000Z" }),
      // A reply by the same account is not a top-level cast, so the account source skips it.
      fakeCast({ fid: 3, hash: fakeHash(3), handle: "dwr", text: "a reply", parentHash: fakeHash(99), parentFid: 5 }),
    ]);
    overrideAdapters({ source });
    const added = await apiJson(cookie, "POST", "/api/farcaster/sources", { kind: "account", value: "@dwr" });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ kind: "farcaster", title: "Dan Romero (@dwr) on Farcaster", feed_url: "farcaster://account/3", in_blogroll: false });
    expect((await apiJson(cookie, "POST", "/api/farcaster/sources", { kind: "account", value: "3" })).status).toBe(409);

    // The importer's own scheduler polls it.
    await runScheduledPoll(env.DB, undefined, later, env);
    const reading = await apiJson(cookie, "GET", `/api/reading?sub=${added.json.id}`);
    expect(reading.status).toBe(200);
    const entries = reading.json.items.map((e: any) => e.imported);
    expect(entries.map((e: any) => e.remoteId)).toEqual([`fc-3-${fakeHash(1)}`, `fc-3-${fakeHash(2)}`]);
    const first = reading.json.items[0];
    expect(first.l0).toBe(true);
    expect(Date.parse(first.displayAt)).toBe(Date.parse("2026-10-27T10:00:00.000Z"));
    expect(first.imported.sourceUrl).toBe(`https://farcaster.xyz/dwr/${fakeHash(1).slice(0, 10)}`);
    expect(first.contentHtml).toContain(">Dan Romero (@dwr)</a>");
    expect(first.contentHtml).toContain("Water is a commons.<br>");
    expect(first.contentHtml).toContain('<img src="https://imagedelivery.net/x/y/original"');
    expect(first.contentHtml).toContain('<a href="https://example.com/article">example.com/article</a>');
    expect(JSON.stringify(reading.json.items)).not.toMatch(/likes?_count|recasts?|follower|reaction/i);
  });

  it("interleaves casts with blog entries by time", async () => {
    const cookie = await login();
    overrideAdapters({ source: new FakeCastSource([fakeCast({ fid: 41, hash: fakeHash(41), text: "middle", createdAt: "2026-09-15T00:00:00.000Z" })]) });
    const fc = await apiJson(cookie, "POST", "/api/farcaster/sources", { kind: "account", value: "41" });
    const rss = await createSubscription(env.DB, { kind: "rss", origin: "https://blog.example/feed", feedUrl: "https://blog.example/feed", title: "A blog" });
    for (const [id, at] of [["new", "2026-09-20T00:00:00.000Z"], ["old", "2026-09-10T00:00:00.000Z"]]) {
      await upsertL0Item(env.DB, rss.id, id, { version: 1, created: at, updated: at, observedAt: "2026-10-01T00:00:00.000Z", contentMd: `[${id}](https://blog.example/${id})`, contentHtml: `<p><a href="https://blog.example/${id}">${id}</a></p>`, contentHash: id });
    }
    await runScheduledPoll(env.DB, undefined, later, env);
    const reading = await apiJson(cookie, "GET", "/api/reading?limit=50");
    const order = reading.json.items.filter((e: any) => [fc.json.id, rss.id].includes(e.imported?.subscriptionId)).map((e: any) => e.imported.remoteId);
    expect(order).toEqual(["new", `fc-41-${fakeHash(41)}`, "old"]);
  });

  it("survives a backend error without breaking the rest of the reader", async () => {
    const cookie = await login();
    const source = new FakeCastSource([fakeCast({ fid: 51, hash: fakeHash(51), text: "first poll" })]);
    overrideAdapters({ source });
    const fc = await apiJson(cookie, "POST", "/api/farcaster/sources", { kind: "account", value: "51" });
    await runScheduledPoll(env.DB, undefined, later, env);
    source.failWith = new FarcasterError("http", "HTTP 503", 503);
    await runScheduledPoll(env.DB, undefined, later + 3600_000, env);
    const sub = await apiJson(cookie, "GET", `/api/subscriptions/${fc.json.id}`);
    expect(sub.json.fail_count).toBe(1);
    expect(sub.json.flags.at(-1)).toMatchObject({ type: "farcaster-error", detail: "http: HTTP 503" });
    // Garbage is an error like any other.
    source.failWith = new FarcasterError("malformed", "hub response has no messages array");
    await runScheduledPoll(env.DB, undefined, later + 7200_000, env);
    const reading = await apiJson(cookie, "GET", "/api/reading?limit=50");
    expect(reading.status).toBe(200);
    expect(reading.json.items.some((e: any) => e.imported?.remoteId === `fc-51-${fakeHash(51)}`)).toBe(true);
  });

  it("records a missing backend configuration as a poll failure, not a crash", async () => {
    const cookie = await login();
    const fc = await apiJson(cookie, "POST", "/api/farcaster/sources", { kind: "channel", value: "water", parent_url: "https://farcaster.xyz/~/channel/water" });
    expect(fc.status).toBe(201);
    await runScheduledPoll(env.DB, undefined, later, env);
    const sub = await apiJson(cookie, "GET", `/api/subscriptions/${fc.json.id}`);
    expect(sub.json.flags.at(-1)).toMatchObject({ type: "farcaster-error", detail: expect.stringContaining("hub URL") });
  });

  it("never lists a Farcaster source in the public blogroll", async () => {
    const cookie = await login();
    overrideAdapters({ source: new FakeCastSource([fakeCast({ fid: 61, hash: fakeHash(61), handle: "secretreader" })]) });
    const fc = await apiJson(cookie, "POST", "/api/farcaster/sources", { kind: "account", value: "61" });
    await apiJson(cookie, "PATCH", `/api/subscriptions/${fc.json.id}`, { in_blogroll: true });
    const opml = await (await getPublic("/blyg/blogroll.opml")).text();
    expect(opml).not.toContain("secretreader");
    expect(opml).not.toContain("farcaster");
  });
});

describe("cast rendering", () => {
  it("shows a cast's text as text, not as markdown", () => {
    const html = renderMarkdown(escapeCastText("# not a heading\n- not a list\n1. not ordered\n*not em* [not](a link) <b>no html</b> & co"));
    expect(html).not.toMatch(/<h1|<ul|<ol|<em|<b>/);
    expect(html).toContain("# not a heading");
    expect(html).toContain("*not em* [not](a link) &lt;b&gt;no html&lt;/b&gt; &amp; co");
  });

  it("keeps bare URLs linked", () => {
    expect(renderMarkdown(escapeCastText("see https://example.com/a_b*c ok"))).toContain('<a href="https://example.com/a_b*c">');
  });

  it("puts the author first, as the link the Studio reads as the entry's title", () => {
    const md = castMarkdown(fakeCast({ fid: 3, hash: fakeHash(7), handle: "dwr", displayName: "Dan [R]", text: "hi", channel: "water", parentHash: fakeHash(8), parentFid: 2 }));
    expect(md.split("\n")[0]).toBe(`[Dan \\[R\\] (@dwr)](https://farcaster.xyz/dwr/${fakeHash(7).slice(0, 10)}) · /water`);
    expect(md).toContain(`↩ in reply to [a cast](https://farcaster.xyz/~/conversations/${fakeHash(8)})`);
  });

  it("round-trips source specs and cast ids", () => {
    const channel = { kind: "channel" as const, channel: { id: "water", parentUrl: "https://farcaster.xyz/~/channel/water" } };
    expect(parseSourceSpec(specToFeedUrl(channel))).toEqual(channel);
    expect(parseSourceSpec(specToFeedUrl({ kind: "account", fid: 3 }))).toEqual({ kind: "account", fid: 3 });
    expect(parseSourceSpec("https://example.com/feed")).toBeNull();
    expect(parseCastRemoteId(`fc-3-${fakeHash(1)}`)).toEqual({ fid: 3, hash: fakeHash(1) });
    expect(parseCastRemoteId("l0-abc")).toBeNull();
  });
});
