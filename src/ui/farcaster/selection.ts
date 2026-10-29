/*
 * blygcaster (Q7): stub a cast with the passage the owner selected in it, and
 * with the whole cast when nothing is selected.
 *
 * The selection is remembered as it is made, not read when "stub ↗" is
 * pressed, because on iPad Safari and phones tapping a button clears the
 * selection before the click arrives. A remembered selection counts only for
 * the entry it was made in, and only for two minutes.
 */

const FRESH_MS = 2 * 60_000;
let last: { key: string; text: string; at: number } | null = null;

function entryKeyOf(node: Node | null): string | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>('.reading-entry[data-key], .reading-article[data-key]')?.dataset.key ?? null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return;
    const key = entryKeyOf(selection.anchorNode);
    const text = selection.toString().trim();
    if (key && text && key === entryKeyOf(selection.focusNode)) last = { key, text, at: Date.now() };
  });
}

/** `{ selection }` for a stub of a cast, when the owner selected a passage in this entry; `{}` otherwise. */
export function castSelection(entryKey: string, remoteId: string): { selection?: string } {
  if (!remoteId.startsWith('fc-') || !last || last.key !== entryKey || Date.now() - last.at > FRESH_MS) return {};
  const text = last.text;
  last = null;
  return { selection: text };
}
