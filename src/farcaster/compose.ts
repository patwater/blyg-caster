// What blygcaster writes: the cast for a published item (Q12, Q13, Q17, Q18),
// the reply offered after stubbing a cast (Q16), and the stub draft itself
// (brief §5, Q7, Q9).

import { normalizeSelection, quoteLines, selectionText } from "../markdown.ts";
import { graphemePrefix } from "../text.ts";
import type { FarcasterSettings } from "./config.ts";
import { escapeCastText, authorLabel } from "./reading.ts";
import type { CastDraft } from "./sink.ts";
import { CAST_TEXT_MAX_BYTES } from "./sink.ts";
import type { Cast, CastRef } from "./types.ts";

const utf8 = (s: string): number => new TextEncoder().encode(s).length;

/**
 * `text` cut to at most `maxBytes` of UTF-8, at a word boundary when one is
 * near, with an ellipsis. Grapheme-safe: no emoji is cut in half.
 */
export function fitBytes(text: string, maxBytes: number): string {
  if (utf8(text) <= maxBytes) return text;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  let lo = 0;
  let hi = graphemes.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8(graphemes.slice(0, mid).join("").trimEnd() + "…") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let cut = graphemes.slice(0, lo).join("");
  const space = cut.search(/\s\S*$/);
  if (space > cut.length - 40 && space > 0) cut = cut.slice(0, space);
  return cut.trimEnd() + "…";
}

export interface CrosspostInput {
  kind: "fragment" | "thread";
  /** The published version's content_html. */
  html: string;
  /** The item's permalink on the owner's domain: always the cast's embed. */
  url: string;
  /** The version discloses generated text (its generated[] is not empty). */
  generated: boolean;
}

/**
 * A fragment is cast as its own text when it fits, and truncated at a word
 * boundary when it does not. A thread is cast as its opening lines. Either
 * way the cast embeds the link back to the item, and carries the owner's AI
 * note when the item discloses generated text.
 */
export function composeCrosspost(input: CrosspostInput, settings: Pick<FarcasterSettings, "ai_note" | "crosspost_channel_id" | "crosspost_channel_parent_url">): CastDraft {
  // A thread opens with the owner's own words, not someone else's: a stub's
  // quote (or any quote) is left out of the cast when there is text besides it.
  const own = input.kind === "thread" ? selectionText(input.html.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")) : "";
  const blocks = (own.trim() ? own : selectionText(input.html)).split("\n").filter(Boolean);
  const body = (input.kind === "fragment" ? blocks : blocks.slice(0, 2)).join("\n\n");
  const note = input.generated && settings.ai_note.trim() ? settings.ai_note.trim() : "";
  const budget = CAST_TEXT_MAX_BYTES - (note ? utf8("\n\n" + note) : 0);
  const fitted = fitBytes(body, budget);
  const text = input.kind === "thread" && fitted === body && blocks.length > 2 ? fitBytes(body + " …", budget) : fitted;
  const draft: CastDraft = { text: note ? (text ? `${text}\n\n${note}` : note) : text, embeds: [input.url] };
  if (settings.crosspost_channel_id) draft.channel = { id: settings.crosspost_channel_id, parentUrl: settings.crosspost_channel_parent_url || null };
  return draft;
}

/** The reply offered after stubbing a cast: the owner's own opening words and a link to the stub. */
export function composeReply(ownWords: string, stubUrl: string, cast: CastRef): CastDraft {
  const words = ownWords.replace(/\s+/g, " ").trim();
  return { text: fitBytes(words, CAST_TEXT_MAX_BYTES), embeds: [stubUrl], parent: { fid: cast.fid, hash: cast.hash } };
}

/**
 * The owner's own words in a stub body: everything that is not quotation.
 * Blockquote lines go, and so do directives and bare whitespace, so a body of
 * a quote plus a few spaces counts as empty (Q8).
 */
export function ownWords(contentMd: string): string {
  return contentMd
    .split("\n")
    .filter((line) => !/^\s{0,3}>/.test(line))
    .join("\n")
    .replace(/!?\[\[[^\]]*\]\]/g, "")
    .trim();
}

/** The citation label for a cast (Q9): name, handle, short hash and FID. */
export function castSourceLabel(cast: Pick<Cast, "displayName" | "handle" | "fid" | "hash">): string {
  return `${authorLabel(cast)} on Farcaster, cast ${cast.hash.slice(0, 10)}, fid ${cast.fid}`;
}

export class PassageNotInCast extends Error {}

/**
 * The stub draft for one cast (brief §5): the chosen passage, or the whole
 * cast when nothing was chosen (Q7), quoted as a markdown blockquote with the
 * owner's words to go below; and a `{url}` stub_of whose `cited` is frozen
 * now, so the label survives the cast's deletion at the source (§7).
 */
export function composeCastStub(cast: Cast, selection: string | undefined, now: string): {
  contentMd: string;
  quoted: string;
  stubOf: { url: string; cited: { source: string; excerpt?: string; url: string; retrieved: string } };
} {
  const whole = normalizeSelection(cast.text);
  let quoted = whole;
  if (typeof selection === "string" && selection.trim()) {
    const chosen = normalizeSelection(selection);
    if (!chosen || !whole.includes(chosen)) throw new PassageNotInCast("that passage is not in this cast");
    quoted = chosen;
  }
  const quote = quoted ? quoteLines(quoted.split("\n").map(escapeCastText).join("\n")) : "";
  const text = cast.text.replace(/\s+/g, " ").trim();
  const excerpt = text.length > 200 ? graphemePrefix(text, 199).trimEnd() + "…" : text;
  return {
    contentMd: quote ? `${quote}\n\n` : "",
    quoted,
    stubOf: {
      url: cast.url,
      cited: { source: castSourceLabel(cast), ...(excerpt ? { excerpt } : {}), url: cast.url, retrieved: now },
    },
  };
}
