# Edits to upstream Studio files

blygcaster keeps its own code in `src/farcaster/`, `extensions/farcaster/`,
`migrations/5001_farcaster.sql`, `test/farcaster/` and the `docs/blygcaster-*`
files. This file lists every edit to a file that came from upstream Blygger
Studio, so that pulling in upstream changes (see `UPSTREAM.md`) stays a matter
of re-applying a known, short list. Each entry says what changed and why, and
whether the hook is generic enough to offer upstream.

## Identity (section 2.2 of the brief)

| File | Change | Offer upstream? |
|---|---|---|
| `src/client.ts` | `CLIENT` is `blygcaster` 0.1.0 at `https://github.com/patwater/blyg-caster`. | No, fork identity. |
| `package.json`, `package-lock.json` | Package name, version, description and repository. | No. |
| `wrangler.jsonc` | Worker name `blygcaster`. | No. |
| `LICENSE` | Adds a copyright line for the blygcaster modifications. Upstream's notice is kept. | No. |
| `src/update-check.ts` | `DEFAULT_UPDATE_FEED` derives from `CLIENT.url`, so a fork points at its own releases. | Yes. It is a one-line generalisation that makes every fork correct by default. |
| `src/ui/settings.tsx` | The release-feed placeholder derives from `CLIENT.url`. | Yes, with the line above. |
| `src/mcp.ts` | The MCP server name derives from `CLIENT.name`. | Yes. |
| `test/surfaces.test.ts`, `test/update-check.test.ts` | Expect the blygcaster name and URL. | No. |
| `README.md` | A blygcaster section above Studio's own README. | No. |

## Reading Farcaster (phase 2)

| File | Change | Offer upstream? |
|---|---|---|
| `src/types.ts` | `SubscriptionRow.kind` gains `"farcaster"`. | No. |
| `src/contract/schemas.ts` | The subscription `kind` enum gains `"farcaster"` (an additive change to this client's own `/api` contract, not the protocol's). | No. |
| `src/importer/store.ts` | `createSubscription` takes any `SubscriptionRow["kind"]`; `listBlogrollSubscriptions` excludes `kind = 'farcaster'`, so Farcaster sources never reach the public blogroll or its OPML. | The exclusion is Farcaster-specific. A generic "private source kinds" filter could be offered. |
| `src/importer/poll.ts` | `pollSubscription` takes an optional `env` and hands a Farcaster subscription to `pollFarcasterSubscription`. | Yes, the optional `env` alone: it lets any future source kind that needs secrets ride the scheduler. |
| `src/importer/schedule.ts` | `pollAll` and `runScheduledPoll` pass an optional `env` through. | Yes, with the line above. |
| `src/index.ts` | The quarter-hour cron passes `env` to `runScheduledPoll`, and drains Farcaster retries (`drainCasts`). | The `env` pass-through, yes. |
| `src/importer/api.ts` | "Resync all feeds" passes `env` to `pollAll`. | Yes, with the above. |
| `src/ui/reading.tsx` | A cast's byline badge reads "farcaster" rather than "legacy rss", and the stub action sends the passage selected in a cast (`castSelection`). | A generic "stub the selected passage of an L0 entry" could be offered; the badge is Farcaster-specific. |
| `extensions/catalog.ts`, `extensions.json` | The browser-only `farcaster` extension is catalogued and compiled into every build. It still starts off; Settings → Farcaster offers to turn it on. | No. |
| `test-ui/default-extensions.test.ts` | Expects `farcaster` among the shipped extensions. | No. |

## Stubbing a cast (phase 3)

| File | Change | Offer upstream? |
|---|---|---|
| `src/item-create.ts` | `createResponseDraft` hands a Farcaster entry to `createCastStubDraft`. | No. |
| `src/api.ts` | `publishAndNotify` refuses a stub of a cast with no words of the owner's own (`emptyCastStubProblem`), before publishing. | A general "a stub needs words of its own" setting could be offered; this check covers only cast stubs. |

## Cross-posting (phase 4)

| File | Change | Offer upstream? |
|---|---|---|
| `src/api.ts` | After a publish, `waitUntil(onPublished(...))`; after a withdrawal, `waitUntil(onWithdrawn(...))`. Neither can fail or delay the response. | A generic post-publish/post-withdraw hook list for core modules could be offered. |
| `src/pages.ts` | A permalink page (fragment and thread) shows "Also on Farcaster ↗" when the item has a live cast (Q19). Page chrome only. | No. |

## Routes, scopes and the contract

| File | Change | Offer upstream? |
|---|---|---|
| `src/contract/routes.ts` | Spreads `farcasterRoutes` (`src/farcaster/contract.ts`) into `routes`. | No. |
| `src/owner-api.ts` | Mounts `farcasterApi` behind the owner middleware. | No. |
| `src/permissions.ts` | `setFarcasterCrosspost` and `replyOnFarcaster` require `owner:publish`; the other Farcaster writes fall to `owner:manage`, reads to `owner:read`. | No. |
| `openapi.json`, `sdk/generated/*` | Regenerated with `npm run sdk:generate`. | No (generated). |
| `test/rest-permissions.oracle.test.ts`, `test/mcp.oracle.test.ts`, `test/sdk-operations.test.ts` | The operation inventories list the nine Farcaster operations. | No. |

## The editor and Settings

| File | Change | Offer upstream? |
|---|---|---|
| `src/ui/authoring.tsx` | Renders `<FarcasterPanel>` under the stub and fork lines: the cross-post toggle, cast status and reply offer. | No. |
| `src/ui/settings.tsx` | Adds the Farcaster section and its sidebar anchor. The section saves through its own route, and its buttons never submit the Studio's form. | No. |

## Tests and tooling

| File | Change | Offer upstream? |
|---|---|---|
| `scripts/e2e-server.ts` | Starts one more Miniflare instance (port 8793, its own database, `FARCASTER_FAKE=1`) for `e2e/farcaster.spec.ts`, so that spec's published stubs and drained outbound queue never touch other specs' fixtures. | No. |
| `scripts/check-template.ts` | The template's Worker name is `blygcaster`. | No. |
| `package.json`, `package-lock.json` | `@noble/hashes` 2.4.0 (already in the tree via better-auth) becomes a direct dependency, for BLAKE3. | No. |

## Files that are blygcaster's own

`src/farcaster/*`, `src/ui/farcaster/*`, `extensions/farcaster/*`,
`migrations/5001_farcaster.sql`, `test/farcaster/*`, `e2e/farcaster.spec.ts`,
`scripts/farcaster-golden-vectors.mjs`, `scripts/farcaster-signer-keygen.mjs`,
`UPSTREAM.md` and `docs/blygcaster-*.md`.
