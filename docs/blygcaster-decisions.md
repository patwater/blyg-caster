# blygcaster decisions

This file records the owner's answers to the brief's section 9 questions, the
backend chosen, the documentation consulted, and everything that could not be
verified against the real Farcaster network from the build sandbox. The answers
were given on 2026-10-29, before any code was written.

## Answers to section 9

Each answer says whether the suggested default was accepted.

### Reading

1. **Sources.** The reader uses an accounts and channels list edited in Settings. *(Default accepted.)*
2. **Placement.** Casts are interleaved with blog entries in the one reading view, as a subscription kind, with a source filter. *(Default accepted.)*
3. **Threads.** The reader shows a flat list, with a "view thread" sheet that loads parents and replies on demand. *(Default accepted.)*
4. **Media.** Images render inline, and other links stay plain links. *(Default accepted.)*
5. **Refresh.** The feed refreshes on the importer's normal polling schedule, plus pull to refresh. *(Default accepted.)*

### Stubbing

6. **Stub control.** Each cast has a visible stub button. *(Default accepted.)*
7. **Quoting.** The owner selects a passage, and the whole cast is quoted when nothing is selected. *(Default accepted.)*
8. **Empty stubs.** Publishing a stub with no words of the owner's own is blocked, with an explanation. *(Default accepted.)*
9. **Source label.** The label reads name, handle and short hash, as in `Dan Romero (@dwr) on Farcaster, cast 0x1a2b3c4d, fid 3`. *(Default accepted.)*
10. **Stubbed marker.** A cast the owner has already stubbed carries a marker linking to the stub. *(Default accepted.)*

### Cross-posting

11. **Trigger.** A per-item toggle at publish triggers a cast, and it is off by default. *(Default accepted.)*
12. **Cast body.** A fragment is cast as its own text when it fits, and a thread is cast as its first lines plus a link. Every cast carries a link back to the item on the owner's domain. *(Default accepted.)*
13. **Long fragments.** A fragment that does not fit is truncated at a word boundary, with the link. *(Default accepted.)*
14. **Republish after an edit.** **Delete and recast.** *(Changed from the default, which was "nothing".)* When a new version of an item that was cross-posted is published, blygcaster deletes the earlier cast and casts the new version. A publish that does not produce a new version (for example a pin, or a repeated publish of unchanged words) does not re-cast, which keeps the acceptance criterion in section 6 and the pin rule in section 3.
15. **Withdrawal.** Withdrawing an item deletes its cast. *(Default accepted.)*
16. **Reply offer.** After a stub of a cast is published, blygcaster offers a one-tap Farcaster reply to that cast with a link to the stub. It never replies automatically. *(Default accepted.)*
17. **Channel.** **A configurable channel.** *(Changed from the default, which was "no channel".)* Settings holds one optional channel that every cross-post goes to. A blank setting means no channel.
18. **AI disclosure.** When an item contains generated spans, the cast carries a short note saying so. *(Default accepted.)*
19. **Permalink link.** **Yes.** *(Changed from the default, which was "no".)* A permalink page shows a small "also on Farcaster" link when the item has a live cast. This is presentation in the page chrome only. The cast record still never enters item documents, the feed, the archive index, `content_html` or the manifest.

### Backend, device and scope

20. **Posting backend.** **The owner's own signer, submitting to a Snapchain hub, is built first**, with a Neynar sink second. *(Asked after reading both sets of shapes, per the brief, and the recommendation was accepted.)* Reasoning: Neynar took over Farcaster in January 2026 and sold it to Network School on 2026-10-15, and most of Neynar's staff moved with the sale, so the future of Neynar's API is unclear. With a managed signer, Neynar holds the signing key. With the owner's own signer, the Worker holds only an Ed25519 signer key (a secret), registered once by the custody wallet outside the Worker, and it can submit to any Snapchain node. Reading defaults to the hub adapter, with Neynar selectable in Settings.
21. **Device.** **iPad Safari first.** *(Changed from the default, which was "phone first".)* Layouts are designed for iPad Safari first and must still work at phone width, which section 6 requires.
22. **Audience.** **Others may run it too.** *(Changed from the default, which was "just me".)* No personal values are hardcoded, setup is documented for any operator, and every Farcaster setting has a safe empty default.
23. **Upstream.** **The repository is planned to be public, and generic pieces are to be offered back to upstream Studio.** *(Changed from the default, which was "decide later".)* Farcaster code stays separable, and edits to upstream files are kept small and listed in `docs/blygcaster-hooks.md` so that any generic hook can be proposed upstream on its own.

## Repository setup

- The GitHub repository `patwater/blyg-caster` already existed with one commit holding an MIT `LICENSE`. The brief's step 2.1 says to delete `.git` and run `git init -b main`, but doing that would have discarded that commit and made the existing remote need a force-push. The snapshot was therefore committed on top of the existing initial commit. The histories are still unrelated to upstream, which is what the step was for.
- Upstream commit: `b93ac12fb6c2abb9a2a0c3eaa9c764041c55f228`, Studio 0.48.2. See `UPSTREAM.md`.
- `LICENSE` keeps upstream's MIT text and Venkatesh Rao's copyright notice, which MIT requires, and adds a line for the blygcaster modifications.
- The brief says the `CLIENT` constant is in `src/types.ts`. Since upstream 0.48 it lives in `src/client.ts`, and `src/types.ts` re-exports it. The name, version (`0.1.0`) and `url` were changed there. `generator` and `generator_url` derive from it.
- The update check's default release feed now derives from `CLIENT.url`, because upstream's comment says a fork must not be told it is out of date by upstream's releases.
- Nothing has been pushed, and nothing has been deployed.

## Baseline test run, before any change

Run on 2026-10-29 against the unmodified snapshot, after `npm install --legacy-peer-deps` (Node 22.22.0, npm 10.9.4):

```
Test Files  147 passed (147)
     Tests  1848 passed | 5 skipped (1853)
  Duration  503.81s
```

There were no pre-existing failures. Any later failure is this fork's.

## Documentation consulted

The build sandbox could not reach any Farcaster or documentation host. `curl` to `docs.neynar.com`, `api.neynar.com`, `snapchain-api.neynar.com`, `hub.pinata.cloud`, `docs.farcaster.xyz` and `snapchain.farcaster.xyz` failed, and the web-fetch tool reported `docs.neynar.com` as outside the session's allowed domains. The npm registry was reachable, so request and response shapes were read from the current published packages, whose code is generated from the services' own definitions:

| Source | Version, published | What was read |
|---|---|---|
| `@neynar/nodejs-sdk` (npm) | 3.177.0, 2026-10-26 | `build/api/apis/{cast,feed,signer}-api.js` and `build/api/models/*.d.ts`: `POST /v2/farcaster/cast/` (`PostCastReqBody`: `signer_uuid`, `text`, `embeds[{url}|{cast_id}]`, `parent`, `parent_author_fid`, `channel_id`, `idem`), `DELETE /v2/farcaster/cast/` (`signer_uuid`, `target_hash`), `GET /v2/farcaster/cast/?identifier&type=hash|url`, `GET /v2/farcaster/cast/conversation/`, `GET /v2/farcaster/feed/user/casts/?fid`, `GET /v2/farcaster/feed/?feed_type=filter&filter_type=fids&fids` (max 100 FIDs), `GET /v2/farcaster/feed/channels/?channel_ids` (max 10), the `Cast`, `User`, `Embed` and `Channel` models, and `x-api-key` authentication against `https://api.neynar.com`. |
| `@farcaster/core` (npm) | 0.21.0, 2026-10-26 | `dist/index.d.ts` and `dist/index.js`: the `Message`, `MessageData`, `CastAddBody` (now with `type`, `formatVersion` and `chain`), `CastRemoveBody`, `CastId` and `Embed` protobuf shapes; `FARCASTER_EPOCH = 1609459200000`; validation limits (a plain cast is at most 320 bytes of text, a long cast at most 1024, and at most 4 embeds). |
| Web search, 2026-10-29 | | The Snapchain HTTP API as summarised from `docs.neynar.com/snapchain/httpapi/*` and `docs.farcaster.xyz/developers/guides/querying/fetch-casts` (default port 3381, `GET /v1/castsByFid`, `POST /v1/submitMessage` with a protobuf body as `application/octet-stream`, `pageSize`/`pageToken`/`nextPageToken`). The pages themselves could not be opened. |
| Web search, 2026-10-29 | | The October 2026 sale to Network School: [The Block via cryptorank](https://cryptorank.io/insights/deals/farcaster-m-a-2026-10-15), [dealroom](https://dealroom.co/news/163046-balajis-network-school-buys-farcaster-rebrands-it-network-state-protocol/), [KuCoin](https://www.kucoin.com/news/flash/farcaster-changes-hands-for-third-time-in-nine-months). No source said whether the Neynar API or the hub endpoints change under Network School. |

The doc pages that should be re-read before the first live run, once the
network allows them:

- https://docs.neynar.com/reference/publish-cast
- https://docs.neynar.com/reference/delete-cast
- https://docs.neynar.com/reference/lookup-cast-by-hash-or-url
- https://docs.neynar.com/reference/fetch-feed
- https://docs.neynar.com/reference/fetch-casts-for-user
- https://docs.neynar.com/reference/fetch-feed-by-channel-ids
- https://docs.neynar.com/snapchain/httpapi/casts
- https://docs.neynar.com/snapchain/httpapi/message
- https://docs.neynar.com/snapchain/httpapi/userdata
- https://docs.farcaster.xyz/developers/guides/writing/messages

To let a future session read them, add `docs.neynar.com`, `docs.farcaster.xyz`,
`api.neynar.com` and a Snapchain host to the environment's allowed network
domains.

## Architecture choices made while building

- **Reading is a subscription kind, not a separate page** (brief §5, Q2). A Farcaster account or channel is a `subscriptions` row of kind `farcaster`, and each cast is an ordinary L0 row in `imported_items`. The importer's own scheduler polls it every 30 minutes, with the usual jitter and backoff. Pull to refresh is the reader's existing resync button. The reading view, the source filter, read state, hoppers and the stub action therefore all work unchanged. The importer allowed this with one change: `pollSubscription` needed the Worker's `env` to reach the secrets, so an optional `env` now passes through the scheduler. The fallback page at `/studio/ext/farcaster` was not needed for reading. It hosts the cast log instead.
- **The source spec lives in the subscription's `feed_url`** (`farcaster://account/3`, `farcaster://channel/water?parent_url=…`). Deleting a subscription through the ordinary route therefore leaves nothing behind.
- **Stubbing uses Studio's own "stub ↗"** for the visible button (Q6). The server-side response draft hands a cast to `createCastStubDraft`, which quotes the words held locally. Stubbing a cast never waits on the network, and the quote is what the owner read. The passage chosen in the reader is remembered on `selectionchange`, because on iPad Safari and phones a tap on a button clears the selection before the click arrives.
- **The brief's `openDraft` sketch is implemented server side.** The `CreateItemData` type (`kind`, `content_md`, `stub_of` with `{url, cited}`) and the extension context's `openDraft` were confirmed as the brief asked. The draft is composed on the server (`src/farcaster/compose.ts`), because the server holds the cast and the passage check, so a client cannot build a cast stub that misquotes it.
- **UI placement.** The reader tools (the thread sheet, the stubbed marker and the cast log) are a browser-only Studio extension, `extensions/farcaster`. It ships compiled in and starts off, like every extension, and Settings → Farcaster offers to turn it on. The Settings section and the editor panel are in `src/ui/farcaster/`, each mounted by a one-line hook, because the extension slots do not reach Settings or the editor.
- **Cross-post bookkeeping** is one table, `farcaster_casts`, with one row per cast: a version's cross-post, or a reply. The row carries its own deletion. A row is claimed with a five-minute lease before each attempt, so the cron and a publish's own attempt cannot cast twice at once. Every retry of one cast is byte-identical: the hub sink signs from the row's fixed timestamp, and the Neynar sink sends the row's id as `idem`. A retry therefore cannot make a second cast.
- **"Unchanged" means the cast would read the same.** Studio's `publish()` always makes a new version, so a second publish of unchanged words is detected by comparing the composed cast draft with the live one. The same draft means no new cast. A pin is not a publish, so it never reaches this code.
- **The kill switch holds rather than discards.** When it is off, a publish records the cast as `skipped`, and nothing is cast or deleted. Casts and deletions that were already waiting stay waiting and go out when it is turned back on.
- **The hub sink uses no Farcaster SDK.** `src/farcaster/message.ts` encodes the protobuf by hand, using WebCrypto Ed25519 and `@noble/hashes` BLAKE3 (already in the tree). It is checked byte for byte against vectors from `@farcaster/core` 0.21.0, which is not a dependency (`scripts/farcaster-golden-vectors.mjs`).
- **Accessibility and layout.** Controls are at least 44 px tall. Layouts were checked at iPad width (834 px) and phone width (390 px), in screenshots and in the mobile Playwright project, with no sideways scroll.

## Things to know before relying on it

- **The `/api` contract grew, additively.** The brief says to stop and ask about anything that touches the API contract. These changes are to this client's own contract (decision #31), not to the protocol, and the brief anticipated them ("openapi.json and the SDK are regenerated if any route changed"), so I went ahead and flag them here. There are nine new operations under `/api/farcaster/`, and the `Subscription.kind` enum gains `"farcaster"`. A third-party tool that validates `kind` strictly against `blyg | rss` could reject a Farcaster subscription in `GET /api/subscriptions`. The new operations are also MCP tools under the same scopes. Casting (`setFarcasterCrosspost`, `replyOnFarcaster`) needs `owner:publish`.
- **No protocol meaning was changed.** Item documents, the feed, the archive index, the manifest, `content_html` and mentions are untouched. A stub of a cast is an ordinary `{url}` stub per §10.6. The public blogroll and its OPML exclude Farcaster sources.
- **A lost answer followed by a withdrawal can leave a cast behind.** Suppose a post reaches Farcaster but its answer is lost (a timeout), and the item is withdrawn before the retry. The row is then cancelled with no hash to delete. With the hub sink the hash is deterministic, so a later version could compute it. This is not built.
- **Turning cross-posting off for an item does not delete its cast.** It only stops future publishes from casting. Withdraw the item to delete the cast.
- **The reply offer is made once per stub.** The reply is deleted when the stub is withdrawn, but it is not recast when the stub is republished.
- **Account sources show top-level casts only.** Replies appear in the thread sheet.
- **A channel read through a hub needs its parent URL.** Hubs know channels only by that URL.
- **Reading cards show the date, as Studio's cards do.** The thread sheet shows the time of day.

## Unverified against the real network

Everything below was built against fake adapters and recorded fixtures, and it
has never talked to a real Farcaster host. It is to be checked on the first live run.

### Phase 1, data layer

- **Message encoding is verified offline, but not against a node.** The hand-written CastAdd and CastRemove encoder (`src/farcaster/message.ts`) matches `@farcaster/core` 0.21.0 byte for byte, including the BLAKE3 hash and the Ed25519 signature (`test/farcaster/message.test.ts`). Whether a live Snapchain node accepts these messages has not been checked.
- **The hub HTTP paths and query names are unverified:** `GET /v1/castsByFid?fid&pageSize&reverse&pageToken`, `/v1/castById?fid&hash`, `/v1/castsByParent?fid&hash` (replies) and `?url` (channels), `/v1/userDataByFid?fid`, `/v1/userNameProofByName?name`, and `POST /v1/submitMessage` with the encoded Message as `application/octet-stream`.
- **The hub's JSON encoding of bytes is unverified.** `@farcaster/core`'s `toJSON` gives base64, and the hub HTTP API has historically given `0x` hex. `normalizeHash` accepts both.
- **The hub's duplicate and not-found error bodies are unverified.** The sink treats a 4xx whose body says "duplicate" as success on retry, and a removal of an unknown cast as already done.
- **The Neynar shapes come from the 2026-10-26 SDK, not from live calls.** Whether Neynar's API keeps running under Network School is unknown.
- **The default cast URL template** `https://farcaster.xyz/{handle}/{shortHash}` and the handle-free fallback `https://farcaster.xyz/~/conversations/{hash}` are unverified. Both are settings, because the web domain is a display detail.
- **The "public reference node"** at `snapchain.farcaster.xyz` (port 3381) named in search results is not assumed anywhere. The hub URL has no default, and the operator sets it.

### Phases 2 to 4

- **Every Farcaster read and write in the reader, the stub flow and cross-posting was exercised against the fake adapters only**, in the Worker suite (`test/farcaster/*.test.ts`) and in the browser (`e2e/farcaster.spec.ts`, desktop and mobile).
- **The hub source looks up names with `/v1/userDataByFid`** and caches them for a week in `farcaster_accounts`. It puts @mentions back at their UTF-8 byte positions. Both are unverified against real hub data.
- **Neynar's `members_only=false` and `with_replies=false` on channel feeds**, and `include_replies=false` on user casts, come from the SDK's parameter list and are unverified.
- **Posting into a channel through the hub uses the channel's parent URL as `parentUrl`.** Whether a given channel's parent URL is `https://farcaster.xyz/~/channel/<id>`, an older `warpcast.com` URL or a `chain://` URL varies by channel and is unverified. The owner enters it.
- **The signer registration steps in `docs/blygcaster-signer.md` are described, not run.** No custody wallet was involved at any point.

## Test results at the end of the build

All runs were on 2026-10-29, after every change.

| Suite | Command | Result |
|---|---|---|
| Worker (vitest, workerd) | `npm test` | 152 files passed; 1917 tests passed, 5 skipped. The baseline was 147 files and 1848 passed. The five new files are `test/farcaster/*`, 69 tests. |
| UI unit | `npm run test:ui` | 14 files, 111 tests passed. |
| Browser (Playwright, desktop and mobile) | `npm run test:e2e` | 367 passed, 5 skipped, 0 failed. `e2e/farcaster.spec.ts` runs on its own Miniflare instance. |
| Types | `npm run typecheck` | Clean. |
| Template guard | `npm run check:template` | Shippable. |

A first full browser run had two failures, the same parity test on desktop and mobile. They were caused by `e2e/farcaster.spec.ts` publishing a cast stub on the shared fixture database. Publishing an item with references drains the whole outbound mention queue, which processed the parity fixture's pending row early. The Farcaster spec now has its own instance, and upstream's spec is unchanged.
