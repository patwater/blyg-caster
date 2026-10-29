# Upstream

blygcaster is a fork of [Blygger Studio](https://github.com/blygger/blygger-studio)
(MIT). It was imported as a plain snapshot, not as a git fork, so the two
histories are unrelated and `git merge` between them will not work.

| | |
|---|---|
| Upstream repository | https://github.com/blygger/blygger-studio |
| Upstream commit | `b93ac12fb6c2abb9a2a0c3eaa9c764041c55f228` |
| Upstream version | 0.48.2 (2026-10-20) |
| Snapshot commit here | the commit titled "Snapshot of blygger/blygger-studio at b93ac12 (0.48.2)" |

## Pulling in upstream changes

Take upstream changes by diff, one upstream range at a time:

```bash
git clone https://github.com/blygger/blygger-studio /tmp/upstream
cd /tmp/upstream
git diff b93ac12fb6c2abb9a2a0c3eaa9c764041c55f228 <new-upstream-commit> > /tmp/upstream.patch
cd -   # back in blygcaster
git apply --3way /tmp/upstream.patch
```

Then resolve conflicts, run `npm run sdk:generate` if any route changed, run
`npm test`, and update the commit hash and version in the table above.

Conflicts should be confined to the files listed in
[`docs/blygcaster-hooks.md`](docs/blygcaster-hooks.md), which records every
edit this fork makes to a file that came from upstream. Everything else that is
blygcaster's own lives in `src/farcaster/`, `extensions/farcaster/`,
`migrations/9*_farcaster_*.sql`, `test/farcaster/` and the `docs/blygcaster-*`
files, which upstream never touches.

Do not use `npm run upgrade` here. That script merges upstream release tags into
a clone of upstream, which assumes shared history.
