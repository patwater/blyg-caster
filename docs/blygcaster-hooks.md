# Edits to upstream Studio files

blygcaster keeps its own code in `src/farcaster/`, `extensions/farcaster/`,
`migrations/9*_farcaster_*.sql`, `test/farcaster/` and the `docs/blygcaster-*`
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
