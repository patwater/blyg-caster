// Phase 4 acceptance, against a fake sink: a failed cast never fails or delays
// a publish; a second publish of an unchanged item does not re-cast; a
// withdrawal deletes the cast. Plus the rest of the cross-posting rules:
// off by default, the retry schedule, delete-and-recast on an edit (Q14),
// no re-cast on a pin, the kill switch, and the reply offer (Q16).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeCrosspost, fitBytes } from "../../src/farcaster/compose.ts";
import { overrideAdapters, putFarcasterSettings } from "../../src/farcaster/config.ts";
import { drainCasts, RETRY_DELAYS_MS } from "../../src/farcaster/crosspost.ts";
import { FakeCastSink, FakeCastSource, fakeCast, fakeHash } from "../../src/farcaster/fake.ts";
import { FarcasterError } from "../../src/farcaster/types.ts";
import { runScheduledPoll } from "../../src/importer/schedule.ts";
import { apiJson, createAndPublish, getPublic, login } from "../helpers.ts";

let sink: FakeCastSink;
beforeEach(async () => {
  sink = new FakeCastSink();
  overrideAdapters({ sink });
  await putFarcasterSettings(env.DB, { fid: 424242, crosspost_enabled: true, crosspost_channel_id: "", ai_note: "Includes AI-generated text." });
});
afterEach(() => overrideAdapters(null));

type Rec = { id: string; status: string; version: number; purpose: string; cast_hash: string | null; attempts: number; next_attempt_at: string | null; text: string; last_error: string | null };

/** The background attempt runs after the response; wait for it to settle. */
async function settled(cookie: string, id: string, until: (records: Rec[]) => boolean): Promise<Rec[]> {
  for (let i = 0; i < 200; i++) {
    const r = await apiJson(cookie, "GET", `/api/farcaster/items/${id}`);
    if (until(r.json.records)) return r.json.records;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("background cast attempt did not settle");
}

async function optedInDraft(cookie: string, text: string): Promise<string> {
  const created = await apiJson(cookie, "POST", "/api/items", { content_md: text });
  const toggled = await apiJson(cookie, "PUT", `/api/farcaster/items/${created.json.id}/crosspost`, { enabled: true });
  expect(toggled.json.enabled).toBe(true);
  return created.json.id;
}

describe("cross-posting", () => {
  it("is off by default: publishing an item casts nothing", async () => {
    const cookie = await login();
    const id = await createAndPublish(cookie, "Not for Farcaster.");
    expect((await apiJson(cookie, "GET", `/api/farcaster/items/${id}`)).json).toMatchObject({ enabled: false, records: [] });
    expect(sink.calls).toEqual([]);
  });

  it("casts an opted-in fragment as its own text, with the link back", async () => {
    const cookie = await login();
    const id = await optedInDraft(cookie, "A short fragment about rivers.");
    expect((await apiJson(cookie, "POST", `/api/items/${id}/publish`, {})).status).toBe(200);
    const records = await settled(cookie, id, (r) => r[0]?.status === "posted");
    expect(records[0]).toMatchObject({ version: 1, purpose: "crosspost", text: "A short fragment about rivers.", attempts: 1 });
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].draft).toEqual({ text: "A short fragment about rivers.", embeds: [`https://example.com/blyg/f/${id}/`] });
  });

  it("never fails a publish when the cast fails, and retries it later", async () => {
    const cookie = await login();
    const id = await optedInDraft(cookie, "Published whatever the network says.");
    sink.failures = [new FarcasterError("http", "HTTP 503", 503)];
    const res = await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, version: 1 });
    const [record] = await settled(cookie, id, (r) => r[0]?.attempts === 1);
    expect(record.status).toBe("pending");
    expect(record.last_error).toBe("http: HTTP 503");
    const wait = Date.parse(record.next_attempt_at!) - Date.now();
    expect(wait).toBeGreaterThan(RETRY_DELAYS_MS[0] - 60_000);
    expect(wait).toBeLessThanOrEqual(RETRY_DELAYS_MS[0]);
    // The public item is there regardless.
    expect((await getPublic(`/blyg/items/${id}.json`)).status).toBe(200);
  });

  it("never delays a publish, even when Farcaster is slow", async () => {
    const cookie = await login();
    const id = await optedInDraft(cookie, "Slow network, fast publish.");
    sink.delayMs = 1500;
    const started = Date.now();
    expect((await apiJson(cookie, "POST", `/api/items/${id}/publish`, {})).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    await settled(cookie, id, (r) => r[0]?.status === "posted");
  });

  it("does not re-cast a second publish of an unchanged item, or a pin", async () => {
    const cookie = await login();
    const id = await optedInDraft(cookie, "Unchanged words.");
    await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    await settled(cookie, id, (r) => r[0]?.status === "posted");
    expect((await apiJson(cookie, "POST", `/api/items/${id}/publish`, {})).json.version).toBe(2);
    expect((await apiJson(cookie, "PUT", `/api/items/${id}/versions/2/pin`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    const records = (await apiJson(cookie, "GET", `/api/farcaster/items/${id}`)).json.records;
    expect(records).toHaveLength(1);
    expect(sink.calls.filter((c) => c.op === "post")).toHaveLength(1);
  });

  it("deletes the old cast and casts the new version when the words change (Q14)", async () => {
    const cookie = await login();
    const id = await optedInDraft(cookie, "First words.");
    await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    const [first] = await settled(cookie, id, (r) => r[0]?.status === "posted");
    await apiJson(cookie, "PATCH", `/api/items/${id}`, { content_md: "Second words." });
    await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    const records = await settled(cookie, id, (r) => r.length === 2 && r.every((x) => ["posted", "deleted"].includes(x.status)));
    expect(records.find((r) => r.version === 1)).toMatchObject({ status: "deleted", cast_hash: first.cast_hash });
    expect(records.find((r) => r.version === 2)).toMatchObject({ status: "posted", text: "Second words." });
    expect(sink.calls.filter((c) => c.op === "delete").map((c) => c.hash)).toEqual([first.cast_hash]);
    expect(sink.live.size).toBe(1);
  });

  it("links a permalink page to its live cast, and nowhere else (Q19)", async () => {
    const cookie = await login();
    const id = await optedInDraft(cookie, "Linked from the page.");
    await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    const [posted] = await settled(cookie, id, (r) => r[0]?.status === "posted");
    const page = await (await getPublic(`/blyg/f/${id}/`)).text();
    expect(page).toContain(`<p class="also-elsewhere"><a href="https://farcaster.xyz/~/conversations/${posted.cast_hash}" rel="noopener">Also on Farcaster ↗</a></p>`);
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).text();
    const feed = await (await getPublic("/blyg/feed.xml")).text();
    const manifest = await (await getPublic("/blyg/blyg.json")).text();
    // The cast record is client-private: its hash and the page's link are on no wire surface.
    for (const surface of [doc, feed, manifest]) {
      expect(surface).not.toContain(posted.cast_hash!);
      expect(surface).not.toContain("Also on Farcaster");
    }
    expect(Object.keys(JSON.parse(doc)).filter((k) => /farcaster|cast/i.test(k))).toEqual([]);
  });

  it("deletes the cast when the item is withdrawn", async () => {
    const cookie = await login();
    const id = await optedInDraft(cookie, "Soon withdrawn.");
    await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    const [posted] = await settled(cookie, id, (r) => r[0]?.status === "posted");
    expect(sink.live.has(posted.cast_hash!)).toBe(true);
    expect((await apiJson(cookie, "POST", `/api/items/${id}/withdraw`, {})).status).toBe(200);
    const [after] = await settled(cookie, id, (r) => r[0]?.status === "deleted");
    expect(after.cast_hash).toBe(posted.cast_hash);
    expect(sink.live.has(posted.cast_hash!)).toBe(false);
  });

  it("deletes a cast that lands after its item was withdrawn", async () => {
    const cookie = await login();
    const id = await optedInDraft(cookie, "Withdrawn mid-flight.");
    sink.delayMs = 300;
    await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    await apiJson(cookie, "POST", `/api/items/${id}/withdraw`, {});
    const [record] = await settled(cookie, id, (r) => r[0]?.status === "deleted");
    expect(sink.live.has(record.cast_hash!)).toBe(false);
  });

  it("retries on the schedule, then gives up, and never makes two casts", async () => {
    const cookie = await login();
    // The cron drains every due record; earlier tests' pending ones are not this test's.
    await env.DB.prepare("UPDATE farcaster_casts SET status = 'cancelled' WHERE status IN ('pending', 'deleting')").run();
    const id = await optedInDraft(cookie, "Retried.");
    sink.failures = Array(6).fill(new FarcasterError("timeout", "no answer"));
    await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    let [record] = await settled(cookie, id, (r) => r[0]?.attempts === 1);
    let now = Date.now();
    for (const delay of RETRY_DELAYS_MS) {
      now += delay;
      await drainCasts(env, { sink, now: () => new Date(now) });
      [record] = (await apiJson(cookie, "GET", `/api/farcaster/items/${id}`)).json.records;
    }
    expect(record).toMatchObject({ status: "failed", attempts: 6, next_attempt_at: null });
    const posts = sink.calls.filter((c) => c.op === "post" && c.draft?.text === "Retried.");
    expect(posts).toHaveLength(6);
    // Every attempt carried the same identity, so a retry can never be a second cast.
    expect(new Set(posts.map((c) => `${c.attempt.idempotencyKey}|${c.attempt.timestamp.toISOString()}`)).size).toBe(1);
  });

  it("stops every write when the kill switch is off", async () => {
    const cookie = await login();
    const id = await optedInDraft(cookie, "Held back.");
    await apiJson(cookie, "PATCH", "/api/farcaster/settings", { crosspost_enabled: false });
    await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    const [record] = await settled(cookie, id, (r) => r.length === 1);
    expect(record).toMatchObject({ status: "skipped", last_error: "cross-posting was switched off in Settings" });
    expect(await drainCasts(env, { sink })).toBe(0);
    expect(sink.calls).toEqual([]);
  });

  it("offers a reply to a stubbed cast, and only on the owner's action (Q16)", async () => {
    const cookie = await login();
    overrideAdapters({ sink, source: new FakeCastSource([fakeCast({ fid: 7, hash: fakeHash(700), handle: "eve", text: "Whose water is it?" })]) });
    const sub = await apiJson(cookie, "POST", "/api/farcaster/sources", { kind: "account", value: "7" });
    await runScheduledPoll(env.DB, undefined, Date.parse("2030-01-01T00:00:00Z"), env);
    const draft = await apiJson(cookie, "POST", "/api/items", { mode: "response", source: { subscription_id: sub.json.id, remote_id: `fc-7-${fakeHash(700)}` } });
    const id = draft.json.id;
    expect((await apiJson(cookie, "GET", `/api/farcaster/items/${id}`)).json).toMatchObject({ can_reply: false, stub: { fid: 7, hash: fakeHash(700) } });
    await apiJson(cookie, "PATCH", `/api/items/${id}`, { content_md: draft.json.content_md + "It belongs to the basin." });
    await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    expect((await apiJson(cookie, "GET", `/api/farcaster/items/${id}`)).json.can_reply).toBe(true);
    expect(sink.calls).toEqual([]);
    const reply = await apiJson(cookie, "POST", `/api/farcaster/items/${id}/reply`);
    expect(reply.status).toBe(201);
    const records = await settled(cookie, id, (r) => r[0]?.status === "posted");
    expect(records[0].purpose).toBe("reply");
    expect(sink.calls[0].draft).toEqual({ text: "It belongs to the basin.", embeds: [`https://example.com/blyg/t/${id}/`], parent: { fid: 7, hash: fakeHash(700) } });
    expect((await apiJson(cookie, "POST", `/api/farcaster/items/${id}/reply`)).status).toBe(409);
  });
});

describe("what gets cast", () => {
  const settings = { ai_note: "Includes AI-generated text.", crosspost_channel_id: "", crosspost_channel_parent_url: "" };

  it("truncates a long fragment at a word boundary, within 320 bytes", () => {
    const words = "Watershed ".repeat(60).trim();
    const draft = composeCrosspost({ kind: "fragment", html: `<p>${words}</p>`, url: "https://b.example/f/x/", generated: false }, settings);
    expect(new TextEncoder().encode(draft.text).length).toBeLessThanOrEqual(320);
    expect(draft.text.endsWith("Watershed…")).toBe(true);
    expect(draft.embeds).toEqual(["https://b.example/f/x/"]);
  });

  it("casts a thread as its opening lines", () => {
    const draft = composeCrosspost({ kind: "thread", html: "<h1>On basins</h1><p>First paragraph.</p><p>Second.</p><p>Third.</p>", url: "https://b.example/t/x/", generated: false }, settings);
    expect(draft.text).toBe("On basins\n\nFirst paragraph. …");
  });

  it("casts a stub's own words, not the passage it quotes", () => {
    const draft = composeCrosspost({ kind: "thread", html: "<blockquote><p>Their words.</p></blockquote><p>My answer.</p>", url: "https://b.example/t/x/", generated: false }, settings);
    expect(draft.text).toBe("My answer.");
    const quoteOnly = composeCrosspost({ kind: "thread", html: "<blockquote><p>Only a quote.</p></blockquote>", url: "https://b.example/t/x/", generated: false }, settings);
    expect(quoteOnly.text).toBe("Only a quote.");
  });

  it("says so when the item discloses generated text, and fits the note in", () => {
    const draft = composeCrosspost({ kind: "fragment", html: `<p>${"é".repeat(400)}</p>`, url: "https://b.example/f/x/", generated: true }, settings);
    expect(draft.text.endsWith("\n\nIncludes AI-generated text.")).toBe(true);
    expect(new TextEncoder().encode(draft.text).length).toBeLessThanOrEqual(320);
  });

  it("posts to the configured channel", () => {
    const draft = composeCrosspost({ kind: "fragment", html: "<p>x</p>", url: "https://b.example/f/x/", generated: false }, { ...settings, crosspost_channel_id: "water", crosspost_channel_parent_url: "https://farcaster.xyz/~/channel/water" });
    expect(draft.channel).toEqual({ id: "water", parentUrl: "https://farcaster.xyz/~/channel/water" });
  });

  it("never splits a grapheme", () => {
    const out = fitBytes("👩‍👩‍👧‍👦".repeat(20), 50);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(50);
    expect([...new Intl.Segmenter().segment(out.replace("…", ""))].every((g) => g.segment === "👩‍👩‍👧‍👦")).toBe(true);
  });
});
