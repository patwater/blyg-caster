/*
 * blygcaster: Settings → Farcaster (Q1, Q17, Q20, the kill switch).
 *
 * Rendered inside the Settings page's form, but saved on its own through
 * /api/farcaster/settings: these settings are blygcaster's, not Studio's, and
 * none of them reaches a public page. Its buttons are type="button" so they
 * never submit the Studio's own settings form.
 */
import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import type { FarcasterSettings, FarcasterStatus } from '../../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../../sdk/dist/browser.js';
import { changed, client, settings as settingsCollection, subscriptions } from '../data.ts';
import { Button, Failure, basepath, useSettings } from '../components.tsx';
import './farcaster.css';

export const FARCASTER_SECTION = ['farcaster', 'Farcaster'] as const;

/** Enter in a field here would submit the Studio's own settings form. */
const noSubmit = (event: KeyboardEvent) => {
  if (event.key === 'Enter') event.preventDefault();
};

export function FarcasterSettingsSection() {
  const [status, setStatus] = useState<FarcasterStatus>();
  const [draft, setDraft] = useState<FarcasterSettings>();
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    unwrap(BlyggerApi.getFarcasterSettings({ client }))
      .then((s) => {
        if (!live) return;
        setStatus(s);
        setDraft(s.settings);
      })
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, []);
  const set = <K extends keyof FarcasterSettings>(key: K, value: FarcasterSettings[K]) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await unwrap(BlyggerApi.updateFarcasterSettings({ client, body: draft }));
      setStatus(next);
      setDraft(next.settings);
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const text = (key: 'hub_url' | 'cast_url_template' | 'crosspost_channel_id' | 'crosspost_channel_parent_url' | 'ai_note', label: string, hint?: string, placeholder?: string) => (
    <label className="fc-field">
      <span>{label}</span>
      <input id={`fc-${key}`} value={draft?.[key] ?? ''} placeholder={placeholder} onKeyDown={noSubmit} onChange={(e) => set(key, e.target.value)} />
      {hint ? <small className="hint">{hint}</small> : null}
    </label>
  );
  const backend = (key: 'read_backend' | 'write_backend', label: string) => (
    <label className="fc-field">
      <span>{label}</span>
      <select id={`fc-${key}`} value={draft?.[key] ?? 'hub'} onChange={(e) => set(key, e.target.value as 'hub' | 'neynar')}>
        <option value="hub">A Snapchain hub (your own signer)</option>
        <option value="neynar">Neynar (API key{key === 'write_backend' ? ', managed signer' : ''})</option>
      </select>
    </label>
  );
  const secret = (name: keyof FarcasterStatus['secrets']) => (
    <li key={name}>
      <code>{name}</code> {status?.secrets[name] ? <span className="fc-ok">set</span> : <span className="fc-missing">not set</span>}
    </li>
  );
  return (
    <section className="settings-section" id={FARCASTER_SECTION[0]} aria-labelledby="farcaster-h">
      <h2 className="section-title" id="farcaster-h">Farcaster</h2>
      <p className="hint">
        blygcaster reads the Farcaster accounts and channels you list here, and can cast an item from your own account when you turn
        cross-posting on for that item. Nothing here reaches your public pages, feed or item documents.
      </p>
      <Failure error={error} />
      <FarcasterSources />
      <section className="card" id="farcaster-crosspost">
        <h3 className="card-h">cross-posting</h3>
        <label className="check">
          <input id="fc-crosspost_enabled" type="checkbox" checked={draft?.crosspost_enabled ?? true} onChange={(e) => set('crosspost_enabled', e.target.checked)} />
          <span>Allow cross-posting to Farcaster</span>
        </label>
        <p className="hint check-hint">
          The kill switch. Off: nothing is cast or deleted, whatever an item says, until you turn it back on. Each item is still off
          until you turn it on in the editor.
        </p>
        <label className="fc-field">
          <span>Your FID</span>
          <input
            id="fc-fid"
            inputMode="numeric"
            value={draft?.fid ?? ''}
            onKeyDown={noSubmit}
            onChange={(e) => set('fid', /^\d+$/.test(e.target.value) ? Number(e.target.value) : null)}
          />
          <small className="hint">The account your signer key is registered to.</small>
        </label>
        {text('crosspost_channel_id', 'Channel', 'Every cross-post goes to this channel. Leave empty for none.', 'e.g. water')}
        {text('crosspost_channel_parent_url', 'Channel parent URL', 'The hub backend needs it to post into a channel.', 'https://farcaster.xyz/~/channel/water')}
        {text('ai_note', 'Note for items with generated text', 'Added to the cast when the item discloses AI-generated spans.')}
      </section>
      <section className="card" id="farcaster-backend">
        <h3 className="card-h">backend</h3>
        {backend('read_backend', 'Read casts from')}
        {backend('write_backend', 'Post casts through')}
        {text('hub_url', 'Hub URL', 'A Snapchain node’s HTTP API, e.g. https://hub.example.com:3381', 'https://')}
        {text('cast_url_template', 'Cast web page', 'Display only: {handle}, {fid}, {hash}, {shortHash}. A cast’s identity is its FID and hash.')}
        <p className="hint">Worker secrets (set with wrangler, never here):</p>
        <ul className="fc-secrets">
          {(['FARCASTER_SIGNER_KEY', 'FARCASTER_HUB_API_KEY', 'NEYNAR_API_KEY', 'NEYNAR_SIGNER_UUID'] as const).map(secret)}
        </ul>
        {status?.fake ? <p className="hint">The fake backend is on (FARCASTER_FAKE=1): nothing reaches Farcaster.</p> : null}
      </section>
      <p className="fc-save">
        <Button type="button" className="btn" id="fc-save" disabled={busy || !draft} onClick={() => void save()}>
          save Farcaster settings
        </Button>{' '}
        {saved ? <span role="status">saved</span> : null} <a href={`${basepath}/ext/farcaster`}>cast log</a>
      </p>
    </section>
  );
}

/** The accounts and channels list (Q1). Each is an ordinary subscription; removing one uses the ordinary route. */
function FarcasterSources() {
  const rows = useLiveQuery((q) => q.from({ subscription: subscriptions })).data ?? [];
  const sources = rows.filter((s) => s.kind === 'farcaster');
  const core = useSettings();
  const [kind, setKind] = useState<'account' | 'channel'>('account');
  const [value, setValue] = useState('');
  const [parentUrl, setParentUrl] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await changed('subscriptions', 'reading');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const readerTools = core?.extensions?.includes('farcaster') ?? false;
  return (
    <section className="card" id="farcaster-sources">
      <h3 className="card-h">accounts and channels you read</h3>
      <Failure error={error} />
      {sources.length ? (
        <ul className="fc-sources">
          {sources.map((s) => (
            <li key={s.id}>
              <span>{s.title}</span>
              {s.status !== 'active' ? <small className="hint"> ({s.status})</small> : null}{' '}
              <Button
                type="button"
                className="btn fc-quiet"
                disabled={busy}
                onClick={() => void run(() => unwrap(BlyggerApi.deleteSubscription({ client, path: { id: s.id } })))}
              >
                remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">None yet. Casts from the accounts and channels you add appear in Reading, beside your blogs.</p>
      )}
      <div className="fc-add">
        <select aria-label="kind of source" value={kind} onChange={(e) => setKind(e.target.value as 'account' | 'channel')}>
          <option value="account">account</option>
          <option value="channel">channel</option>
        </select>
        <input
          aria-label={kind === 'account' ? '@handle or FID' : 'channel id'}
          placeholder={kind === 'account' ? '@handle or FID' : 'channel id'}
          value={value}
          onKeyDown={noSubmit}
          onChange={(e) => setValue(e.target.value)}
        />
        {kind === 'channel' ? (
          <input aria-label="channel parent URL" placeholder="parent URL (hub backend)" value={parentUrl} onKeyDown={noSubmit} onChange={(e) => setParentUrl(e.target.value)} />
        ) : null}
        <Button
          type="button"
          className="btn"
          id="fc-add-source"
          disabled={busy || !value.trim()}
          onClick={() =>
            void run(async () => {
              await unwrap(BlyggerApi.addFarcasterSource({ client, body: { kind, value: value.trim(), ...(kind === 'channel' && parentUrl.trim() ? { parent_url: parentUrl.trim() } : {}) } }));
              setValue('');
              setParentUrl('');
            })
          }
        >
          add
        </Button>
      </div>
      {!readerTools ? (
        <p className="hint">
          The reader’s Farcaster tools (the thread sheet, the stubbed marker and the reply offer) are off.{' '}
          <Button
            type="button"
            className="btn fc-quiet"
            id="fc-enable-tools"
            disabled={busy || !core}
            onClick={() =>
              void run(
                () =>
                  settingsCollection.update('settings', (row) => {
                    row.extensions = [...new Set([...(row.extensions ?? []), 'farcaster'])].sort();
                  }).isPersisted.promise,
              )
            }
          >
            turn them on
          </Button>
        </p>
      ) : null}
    </section>
  );
}
