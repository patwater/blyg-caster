/*
 * Which casts on screen the owner has stubbed (Q10). One byline per entry
 * asks; requests made in the same moment are batched into one call to
 * GET /api/farcaster/stubs, so a page of casts costs one request.
 */
import { BlyggerApi, unwrap } from '../../../src/ui/extension-api.ts';
import type { BlyggerClient } from '../../../sdk/dist/browser.js';

export interface StubMarker {
  item_id: string;
  status: 'draft' | 'public' | 'withdrawn';
}

/** A cast's identity from its reading entry's remote id (`fc-<fid>-<hash>`). */
export function castOf(remoteId: string | undefined): { fid: number; hash: string } | null {
  const m = remoteId ? /^fc-(\d+)-(0x[0-9a-f]{40})$/.exec(remoteId) : null;
  return m ? { fid: Number(m[1]), hash: m[2] } : null;
}

let pending: Array<{ key: string; resolve: (m: StubMarker | null) => void }> = [];
let timer: ReturnType<typeof setTimeout> | undefined;

export function markerLoader(client: BlyggerClient) {
  return (ref: { fid: number; hash: string }): Promise<StubMarker | null> =>
    new Promise((resolve) => {
      pending.push({ key: `${ref.fid}:${ref.hash}`, resolve });
      timer ??= setTimeout(() => {
        const batch = pending;
        pending = [];
        timer = undefined;
        const keys = [...new Set(batch.map((b) => b.key))].slice(0, 100);
        unwrap(BlyggerApi.listFarcasterStubs({ client, query: { casts: keys.join(',') } })).then(
          (r) => {
            // Newest stub first; a withdrawn one is not a marker worth showing.
            const byKey = new Map<string, StubMarker>();
            for (const row of r.items) {
              const key = `${row.fid}:${row.hash}`;
              if (!byKey.has(key) && row.status !== 'withdrawn') byKey.set(key, { item_id: row.item_id, status: row.status });
            }
            for (const b of batch) b.resolve(byKey.get(b.key) ?? null);
          },
          () => batch.forEach((b) => b.resolve(null)),
        );
      }, 30);
    });
}
