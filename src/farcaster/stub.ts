// Stubbing a cast (brief §5, phase 3).
//
// The reader's own "stub ↗" reaches here for a Farcaster entry (one line in
// item-create.ts), so a cast has the same single, visible response control as
// every other entry (Q6). The draft is a thread whose stub_of is a plain-web
// target: `{url, cited}` with no selector (§10.6), the quoted passage a
// markdown blockquote, and the owner's words to go below it.
//
// Nothing here runs without the owner's explicit action on one cast. There is
// no background or bulk stubbing anywhere in blygcaster.

import { HTTPException } from "hono/http-exception";
import { createDraft } from "../model.ts";
import { parseStoredStub, parseStubOf } from "../stub.ts";
import type { ImportedItemRow, ItemRow } from "../types.ts";
import { nowIso } from "../util.ts";
import { composeCastStub, ownWords, PassageNotInCast } from "./compose.ts";
import { heldCast, parseCastRemoteId } from "./reading.ts";
import type { Cast } from "./types.ts";

/**
 * The stub draft for one imported cast. Quotes the words held locally (what
 * the owner read), never a fresh fetch, so stubbing never waits on Farcaster.
 */
export async function createCastStubDraft(db: D1Database, row: ImportedItemRow, selection?: string): Promise<ItemRow> {
  const ref = parseCastRemoteId(row.remote_id);
  if (!ref) throw new HTTPException(404, { message: "not a cast" });
  const cast: Cast | null = await heldCast(db, ref);
  if (!cast) throw new HTTPException(404, { message: "this cast is no longer held here; refresh the source and try again" });
  let composed: ReturnType<typeof composeCastStub>;
  try {
    composed = composeCastStub(cast, selection, nowIso());
  } catch (e) {
    if (e instanceof PassageNotInCast) throw new HTTPException(400, { message: e.message });
    throw e;
  }
  const parsed = parseStubOf(composed.stubOf);
  if (!parsed.ok) throw new HTTPException(400, { message: parsed.reason });
  const item = await createDraft(db, composed.contentMd, "thread", parsed.stub);
  await db
    .prepare("INSERT INTO farcaster_stubs (item_id, fid, hash, cast_url, quoted, created) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(item.id, cast.fid, cast.hash, cast.url, composed.quoted, nowIso())
    .run();
  return item;
}

export interface CastStubRow {
  item_id: string;
  fid: number;
  hash: string;
  cast_url: string;
  quoted: string;
  created: string;
}

export async function castStubFor(db: D1Database, itemId: string): Promise<CastStubRow | null> {
  return db.prepare("SELECT * FROM farcaster_stubs WHERE item_id = ?").bind(itemId).first<CastStubRow>();
}

export const EMPTY_STUB_MESSAGE =
  "This stub quotes a Farcaster cast but has no words of your own yet. Write your response below the quote, then publish. A stub is a response, so blygcaster will not publish one that only repeats the cast.";

/**
 * Q8: a stub of a cast with no words of the owner's own is blocked, with the
 * reason. Returns the message to refuse with, or null to let publish go on.
 * Only stubs made from a cast are checked; nothing about any other item changes.
 */
export async function emptyCastStubProblem(db: D1Database, item: Pick<ItemRow, "id" | "content_md" | "stub_of">): Promise<string | null> {
  const stub = parseStoredStub(item.stub_of);
  if (!stub || !("url" in stub)) return null;
  const row = await castStubFor(db, item.id);
  // The owner can clear the stub marker in the editor; then it is an ordinary thread.
  if (!row || stub.url !== row.cast_url) return null;
  return ownWords(item.content_md) ? null : EMPTY_STUB_MESSAGE;
}
