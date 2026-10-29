/*
 * farcaster: blygcaster's reader tools for Farcaster entries (Q3, Q10).
 *
 * Browser only. Casts reach the reader as ordinary entries of a 'farcaster'
 * subscription, and the Studio's own "stub ↗" stubs them; this adds, at the
 * end of a cast's byline, a "thread" button that opens a sheet with the
 * cast's parents and replies, and a "stubbed" marker linking to the owner's
 * stub of it. Its page, /studio/ext/farcaster, is the cast log: every cast
 * blygcaster made or tried to make, with its status.
 *
 * No counts, likes or rankings appear anywhere here.
 */
import { useEffect, useState } from 'react';
import { BlyggerApi, Button, Sheet, unwrap } from '../../../src/ui/extension-api.ts';
import type { EntryContext, StudioContext, StudioExtension } from '../../../src/ui/extension-api.ts';
import type { FarcasterCast, FarcasterCastRecord } from '../../../sdk/dist/browser.js';
import { castOf, markerLoader, type StubMarker } from './markers.ts';
import './farcaster.css';

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function author(c: FarcasterCast): string {
  if (c.displayName && c.handle) return `${c.displayName} (@${c.handle})`;
  return c.displayName ?? (c.handle ? `@${c.handle}` : `fid ${c.fid}`);
}

function CastView({ cast, focus }: { cast: FarcasterCast; focus?: boolean }) {
  return (
    <article className={focus ? 'fc-cast fc-focus' : 'fc-cast'} data-cast={cast.hash}>
      <p className="fc-cast-by">
        <a href={cast.url} target="_blank" rel="noreferrer">
          {author(cast)}
        </a>{' '}
        <time dateTime={cast.createdAt}>{when(cast.createdAt)}</time>
      </p>
      {cast.text ? <p className="fc-cast-text">{cast.text}</p> : null}
      {cast.embeds.map((e, i) =>
        e.type === 'image' ? (
          <img key={i} className="fc-cast-img" src={e.url} alt="image from the cast" loading="lazy" />
        ) : e.type === 'link' ? (
          <p key={i} className="fc-cast-link">
            <a href={e.url} target="_blank" rel="noreferrer">
              {e.url}
            </a>
          </p>
        ) : null,
      )}
    </article>
  );
}

function ThreadSheet({ context, ref, close }: { context: EntryContext; ref: { fid: number; hash: string }; close: () => void }) {
  const [thread, setThread] = useState<{ cast: FarcasterCast | null; parents: FarcasterCast[]; replies: FarcasterCast[]; error?: string }>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    unwrap(BlyggerApi.getFarcasterThread({ client: context.client, query: ref })).then(setThread, (e: unknown) =>
      setFailure(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  return (
    <Sheet open onClose={close} title="thread" description="This cast, what it answers, and its direct replies.">
      <div className="fc-thread" data-extension-sheet="farcaster">
        {failure ? <p className="fc-note">Could not load the thread: {failure}</p> : null}
        {!thread && !failure ? <p>…</p> : null}
        {thread?.error ? <p className="fc-note">Part of the thread could not be read: {thread.error}</p> : null}
        {thread?.parents.map((c) => <CastView key={c.hash} cast={c} />)}
        {thread?.cast ? <CastView cast={thread.cast} focus /> : null}
        {thread && thread.replies.length ? <h3 className="fc-replies-h">replies</h3> : null}
        {thread?.replies.map((c) => <CastView key={c.hash} cast={c} />)}
        {context.actions.stub ? (
          <p>
            <Button
              className="btn btn-ghost btn-mini"
              onClick={() => {
                close();
                context.actions.stub?.();
              }}
            >
              stub this cast ↗
            </Button>
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

function Byline({ context }: { context: EntryContext }) {
  const ref = castOf(context.imported?.remoteId);
  const [marker, setMarker] = useState<StubMarker | null>(null);
  useEffect(() => {
    if (!ref) return;
    let live = true;
    markerLoader(context.client)(ref).then((m) => live && setMarker(m));
    return () => {
      live = false;
    };
  }, [context.imported?.remoteId]);
  if (!ref) return null;
  return (
    <span data-extension="farcaster" className="fc-byline">
      {' · '}
      <button type="button" className="fc-inline" onClick={() => context.openSheet((close) => <ThreadSheet context={context} ref={ref} close={close} />)}>
        thread
      </button>
      {marker ? (
        <>
          {' · '}
          <button
            type="button"
            className="fc-inline fc-stubbed"
            title={marker.status === 'public' ? 'Your published stub of this cast' : 'Your stub of this cast (not published)'}
            onClick={() => void context.navigate({ to: '/edit/$id', params: { id: marker.item_id } })}
          >
            {marker.status === 'public' ? 'stubbed ↗' : 'stub draft ↗'}
          </button>
        </>
      ) : null}
    </span>
  );
}

const RECORD_WORDS: Record<string, string> = {
  pending: 'waiting to cast',
  posted: 'cast',
  failed: 'gave up',
  cancelled: 'cancelled',
  deleting: 'deleting',
  deleted: 'deleted',
  skipped: 'skipped (cross-posting was off)',
  delete_failed: 'deletion gave up',
};

function CastLog({ context }: { context: StudioContext }) {
  const [records, setRecords] = useState<FarcasterCastRecord[]>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    unwrap(BlyggerApi.listFarcasterCasts({ client: context.client, query: { limit: 100 } })).then(
      (r) => setRecords(r.items),
      (e: unknown) => setFailure(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  return (
    <div className="fc-log">
      <p>
        Every cast blygcaster has made or tried to make from your account, newest first. Delivery runs after publishing and retries
        at 15 minutes, 1 hour, 4 hours, 12 hours and 24 hours before giving up. A status here is information; it never changes
        whether an item is published.
      </p>
      {failure ? <p className="fc-note">Could not load the log: {failure}</p> : null}
      {records && !records.length ? <p>Nothing cast yet. Turn on “Also cast on Farcaster” in an item’s editor, then publish.</p> : null}
      <ul className="fc-log-list">
        {records?.map((r) => (
          <li key={r.id} data-status={r.status}>
            <p>
              <button type="button" className="fc-inline" onClick={() => void context.navigate({ to: '/edit/$id', params: { id: r.item_id } })}>
                {r.purpose === 'reply' ? 'reply' : 'cross-post'} of v{r.version}
              </button>{' '}
              · <strong>{RECORD_WORDS[r.status] ?? r.status}</strong>
              {r.cast_url && r.status === 'posted' ? (
                <>
                  {' · '}
                  <a href={r.cast_url} target="_blank" rel="noreferrer">
                    open ↗
                  </a>
                </>
              ) : null}{' '}
              <small>{when(r.updated)}</small>
            </p>
            {r.text ? <p className="fc-log-text">{r.text}</p> : null}
            {r.last_error ? <p className="fc-note">{r.last_error}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export const extension: StudioExtension = {
  name: 'farcaster',
  label: 'Farcaster reader tools',
  description: 'For casts in your reader: a thread sheet with parents and replies, and a marker on casts you have stubbed. Adds the cast log under More.',
  entryByline: Byline,
  page: { title: 'Farcaster', component: CastLog },
};
