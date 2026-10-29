// Phase 3 acceptance: publishing a stub of a cast produces a thread whose
// stub_of.url and cited fields are correct; a stub with no words of the
// owner's own is blocked with an explanation; the frozen label survives the
// cast's deletion at the source.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { composeCastStub, ownWords } from "../../src/farcaster/compose.ts";
import { overrideAdapters } from "../../src/farcaster/config.ts";
import { FakeCastSource, fakeCast, fakeHash } from "../../src/farcaster/fake.ts";
import { runScheduledPoll } from "../../src/importer/schedule.ts";
import { apiJson, getPublic, login } from "../helpers.ts";

afterEach(() => overrideAdapters(null));

const LONG = "Rivers carve canyons slowly. " + "The silt carries a memory of every storm upstream, and the floodplain keeps it. ".repeat(4);

async function castInReader(cookie: string, fid: number, n: number, text = LONG) {
  const source = new FakeCastSource([fakeCast({ fid, hash: fakeHash(n), handle: "dwr", displayName: "Dan Romero", text, createdAt: "2026-10-27T10:00:00.000Z" })]);
  overrideAdapters({ source });
  const sub = await apiJson(cookie, "POST", "/api/farcaster/sources", { kind: "account", value: String(fid) });
  await runScheduledPoll(env.DB, undefined, Date.parse("2030-01-01T00:00:00Z"), env);
  return { source, subId: sub.json.id as string, remoteId: `fc-${fid}-${fakeHash(n)}`, url: `https://farcaster.xyz/dwr/${fakeHash(n).slice(0, 10)}` };
}

describe("stubbing a cast", () => {
  it("drafts a thread quoting the whole cast, with a {url} stub_of and a frozen citation", async () => {
    const cookie = await login();
    const cast = await castInReader(cookie, 3, 101);
    const draft = await apiJson(cookie, "POST", "/api/items", { mode: "response", source: { subscription_id: cast.subId, remote_id: cast.remoteId } });
    expect(draft.status).toBe(201);
    expect(draft.json.kind).toBe("thread");
    expect(draft.json.content_md).toBe(`> ${LONG.trim()}\n\n`);
    expect(draft.json.stub_of).toEqual({
      url: cast.url,
      cited: {
        source: `Dan Romero (@dwr) on Farcaster, cast ${fakeHash(101).slice(0, 10)}, fid 3`,
        excerpt: expect.any(String),
        url: cast.url,
        retrieved: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
    });
    expect([...draft.json.stub_of.cited.excerpt].length).toBeLessThanOrEqual(200);
    expect(draft.json.stub_of.cited.excerpt.endsWith("…")).toBe(true);
    expect(draft.json.stub_of).not.toHaveProperty("selector");
  });

  it("quotes only the selected passage, and refuses one that is not in the cast", async () => {
    const cookie = await login();
    const cast = await castInReader(cookie, 102, 102);
    const source = { subscription_id: cast.subId, remote_id: cast.remoteId };
    const draft = await apiJson(cookie, "POST", "/api/items", { mode: "response", source, selection: "The silt carries a memory  of every storm" });
    expect(draft.status).toBe(201);
    expect(draft.json.content_md).toBe("> The silt carries a memory of every storm\n\n");
    const wrong = await apiJson(cookie, "POST", "/api/items", { mode: "response", source, selection: "words the author never wrote" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe("that passage is not in this cast");
  });

  it("blocks a stub with no words of the owner's own, explains why, then publishes once there are some", async () => {
    const cookie = await login();
    const cast = await castInReader(cookie, 103, 103);
    const draft = await apiJson(cookie, "POST", "/api/items", { mode: "response", source: { subscription_id: cast.subId, remote_id: cast.remoteId } });
    const id = draft.json.id;
    const blocked = await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    expect(blocked.status).toBe(400);
    expect(blocked.json.error).toContain("no words of your own");
    await apiJson(cookie, "PATCH", `/api/items/${id}`, { content_md: draft.json.content_md + "   \n\n" });
    expect((await apiJson(cookie, "POST", `/api/items/${id}/publish`, {})).status).toBe(400);

    await apiJson(cookie, "PATCH", `/api/items/${id}`, { content_md: draft.json.content_md + "The floodplain is the archive." });
    const published = await apiJson(cookie, "POST", `/api/items/${id}/publish`, {});
    expect(published.status).toBe(200);
    const doc = await (await getPublic(`/blyg/items/${id}.json`)).json<any>();
    expect(doc.kind).toBe("thread");
    expect(doc.stub_of.url).toBe(cast.url);
    expect(doc.stub_of.cited).toMatchObject({ source: `Dan Romero (@dwr) on Farcaster, cast ${fakeHash(103).slice(0, 10)}, fid 103`, url: cast.url });
    // The cast record is client-private: nothing Farcaster-shaped is added to the document.
    expect(Object.keys(doc).some((k) => /farcaster|cast/i.test(k))).toBe(false);
    expect(JSON.stringify(doc)).not.toContain("fc-103-");
  });

  it("marks a stubbed cast with the stub that answers it", async () => {
    const cookie = await login();
    const cast = await castInReader(cookie, 104, 104);
    const draft = await apiJson(cookie, "POST", "/api/items", { mode: "response", source: { subscription_id: cast.subId, remote_id: cast.remoteId } });
    const markers = await apiJson(cookie, "GET", `/api/farcaster/stubs?casts=104:${fakeHash(104)},104:${fakeHash(999)}`);
    expect(markers.json.items).toEqual([{ fid: 104, hash: fakeHash(104), item_id: draft.json.id, status: "draft" }]);
  });

  it("keeps the frozen label and quote when the cast is deleted at the source", async () => {
    const cookie = await login();
    const cast = await castInReader(cookie, 105, 105);
    const draft = await apiJson(cookie, "POST", "/api/items", { mode: "response", source: { subscription_id: cast.subId, remote_id: cast.remoteId } });
    await apiJson(cookie, "PATCH", `/api/items/${draft.json.id}`, { content_md: draft.json.content_md + "My answer." });
    expect((await apiJson(cookie, "POST", `/api/items/${draft.json.id}/publish`, {})).status).toBe(200);
    const before = await (await getPublic(`/blyg/items/${draft.json.id}.json`)).json<any>();
    cast.source.casts = [];
    await runScheduledPoll(env.DB, undefined, Date.parse("2031-01-01T00:00:00Z"), env);
    const after = await (await getPublic(`/blyg/items/${draft.json.id}.json`)).json<any>();
    expect(after.stub_of).toEqual(before.stub_of);
    expect(after.content_md).toBe(before.content_md);
  });

  it("creates no stub without the owner's action: polling alone makes none", async () => {
    const cookie = await login();
    await castInReader(cookie, 106, 106);
    const stubs = await env.DB.prepare("SELECT COUNT(*) AS n FROM farcaster_stubs WHERE hash = ?").bind(fakeHash(106)).first<{ n: number }>();
    expect(stubs?.n).toBe(0);
  });
});

describe("own words", () => {
  it("is what is left after the quotation", () => {
    expect(ownWords("> quoted\n> more\n\n")).toBe("");
    expect(ownWords("> quoted\n\n   \n")).toBe("");
    expect(ownWords("> quoted\n\nMine.")).toBe("Mine.");
    expect(ownWords("Mine first.\n\n> quoted")).toBe("Mine first.");
  });

  it("composes a stub with no text from an image-only cast", () => {
    const stub = composeCastStub(fakeCast({ fid: 3, hash: fakeHash(1), text: "" }), undefined, "2026-10-29T00:00:00Z");
    expect(stub.contentMd).toBe("");
    expect(stub.stubOf.cited).not.toHaveProperty("excerpt");
  });
});
