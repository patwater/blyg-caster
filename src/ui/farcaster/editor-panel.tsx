/*
 * blygcaster: the editor's Farcaster panel (Q11, Q16, phase 4).
 *
 * The per-item cross-post toggle, off by default; the status of every cast
 * this item has made or tried to make; and, for a published stub of a cast,
 * the one-tap offer to reply to that cast with a link to the stub. Nothing
 * here casts by itself: the toggle decides what the next publish does, and
 * the reply happens only when the owner presses it.
 */
import { useCallback, useEffect, useState } from 'react';
import type { FarcasterItem } from '../../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../../sdk/dist/browser.js';
import { client } from '../data.ts';
import { Button, Failure } from '../components.tsx';
import './farcaster.css';

const STATUS_WORDS: Record<string, string> = {
  pending: 'waiting to cast',
  posted: 'cast',
  failed: 'gave up after retries',
  cancelled: 'cancelled before casting',
  deleting: 'deleting',
  deleted: 'deleted',
  skipped: 'skipped: cross-posting was off',
  delete_failed: 'deletion gave up after retries',
};

export function FarcasterPanel({ item }: { item: { id: string; status: string; version: number } }) {
  const [state, setState] = useState<FarcasterItem>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setState(await unwrap(BlyggerApi.getFarcasterItem({ client, path: { id: item.id } })));
    } catch (e) {
      setError(e);
    }
  }, [item.id]);
  // Reload when a publish or withdrawal makes a new version, and keep
  // reloading while a cast is still on its way: delivery runs after publish.
  useEffect(() => {
    void load();
  }, [load, item.version, item.status]);
  const working = state?.records.some((r) => r.status === 'pending' || r.status === 'deleting') ?? false;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [working, load]);
  if (!state) return error ? <Failure error={error} /> : null;
  const act = async (action: () => Promise<FarcasterItem>) => {
    setBusy(true);
    setError(undefined);
    try {
      setState(await action());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="fc-panel" id="farcaster-panel" aria-label="Farcaster">
      <Failure error={error} />
      <label className="check">
        <input
          id="fc-crosspost"
          type="checkbox"
          checked={state.enabled}
          disabled={busy}
          onChange={(e) => {
            const enabled = e.target.checked;
            void act(() => unwrap(BlyggerApi.setFarcasterCrosspost({ client, path: { id: item.id }, body: { enabled } })));
          }}
        />
        <span>Also cast on Farcaster when I publish</span>
      </label>
      <p className="hint check-hint">
        Off unless you turn it on. Publishing never waits for Farcaster. A new version with new words replaces the cast, and
        withdrawing deletes it.
      </p>
      {state.stub ? (
        <p className="hint">
          A stub of{' '}
          <a href={state.stub.url} target="_blank" rel="noreferrer">
            a Farcaster cast
          </a>
          .{' '}
          {state.can_reply ? (
            <Button
              type="button"
              className="btn fc-quiet"
              id="fc-reply"
              disabled={busy}
              onClick={() => void act(() => unwrap(BlyggerApi.replyOnFarcaster({ client, path: { id: item.id } })))}
            >
              reply to it on Farcaster with a link to this stub
            </Button>
          ) : null}
        </p>
      ) : null}
      {state.records.length ? (
        <ul className="fc-records" aria-label="casts">
          {state.records.map((r) => (
            <li key={r.id}>
              {r.purpose === 'reply' ? 'reply' : `v${r.version}`} ·{' '}
              <span className="fc-status" data-status={r.status}>
                {STATUS_WORDS[r.status] ?? r.status}
              </span>
              {r.cast_url && (r.status === 'posted' || r.status === 'deleting') ? (
                <>
                  {' '}
                  ·{' '}
                  <a href={r.cast_url} target="_blank" rel="noreferrer">
                    open ↗
                  </a>
                </>
              ) : null}
              {r.status === 'pending' && r.attempts ? (
                <small className="hint">
                  {' '}
                  · try {r.attempts + 1} at {r.next_attempt_at ? new Date(r.next_attempt_at).toLocaleTimeString() : 'the next tick'}
                </small>
              ) : null}
              {r.last_error ? <small className="hint"> · {r.last_error}</small> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
