// Q19: a permalink page links to the item's live cast, as page chrome only.
// Nothing is added to the item document, the feed, the archive index, the
// manifest or content_html; this line exists only in the HTML of the item's
// own public page, and only while the cast is live.

import { escapeHref } from "../util.ts";
import { getFarcasterSettings } from "./config.ts";
import { liveCrosspost } from "./crosspost.ts";
import { castWebUrl } from "./normalize.ts";

export async function farcasterPermalinkLine(db: D1Database, itemId: string): Promise<string> {
  try {
    const cast = await liveCrosspost(db, itemId);
    if (!cast?.cast_hash) return "";
    const settings = await getFarcasterSettings(db);
    if (!settings.fid) return "";
    const own = await db.prepare("SELECT handle FROM farcaster_accounts WHERE fid = ?").bind(settings.fid).first<{ handle: string | null }>();
    const url = castWebUrl({ fid: settings.fid, hash: cast.cast_hash, handle: own?.handle ?? null }, settings.cast_url_template);
    return `<p class="also-elsewhere"><a href="${escapeHref(url)}" rel="noopener">Also on Farcaster ↗</a></p>`;
  } catch {
    // A public page never fails over a client-private extra.
    return "";
  }
}
