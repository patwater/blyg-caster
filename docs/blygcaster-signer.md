# Setting up blygcaster's Farcaster signer and secrets

blygcaster reads Farcaster with no key at all (hub backend) or with a Neynar
API key, and posts from your own account with a signer. This page is the
one-time setup. It is written for whoever runs the Worker, which may be you or
anyone else running this fork on their own Cloudflare account.

**Two rules hold throughout.** Nothing in this repository asks for, accepts or
stores your custody wallet's private key or recovery phrase, and you should
never paste either into a terminal command, a file in this repository or a
Worker secret. The Worker holds only an app signer key (or a Neynar signer
UUID), which can post and delete casts as you, and which your custody wallet
can revoke at any time.

## The secrets

Set each one with `wrangler secret put <NAME>` (add `--name <worker>` or
`--config wrangler.private.jsonc` as your deployment needs). They are never
read from a file in the repository, and Settings → Farcaster shows only
whether each is set.

| Secret | Needed for | What it is |
|---|---|---|
| `FARCASTER_SIGNER_KEY` | posting through a hub (the default) | Your app signer's Ed25519 private key, 64 hex characters, from the script below. |
| `FARCASTER_HUB_API_KEY` | optional | Sent as `x-api-key` to a hub that wants one, such as Neynar's hosted Snapchain API. |
| `NEYNAR_API_KEY` | reading or posting through Neynar | Your Neynar API key. |
| `NEYNAR_SIGNER_UUID` | posting through Neynar | A Neynar managed signer that your account approved. |

Settings that are not secret (your FID, the hub URL, the backends, the
channel, the kill switch) live in **Settings → Farcaster**.

## Option A: your own signer, posting to a hub (recommended)

This is the default because no API company holds the key that posts as you
(see `docs/blygcaster-decisions.md`, Q20).

1. **Make the key on your own machine.**

   ```bash
   node scripts/farcaster-signer-keygen.mjs ~/.config/blygcaster/signer.key
   ```

   This writes the private key to that file (mode 600; the script refuses a
   path inside the repository) and prints the public key.

2. **Register the public key to your FID, with your custody wallet, outside
   the Worker.** A Farcaster app key is added on OP Mainnet by your custody
   address calling the Key Gateway's `add` function with key type 1
   (Ed25519), your public key, and a signed key request in the metadata. For a
   key you use yourself, the request may be signed by your own FID's custody
   address. Do this with wallet tooling you already trust, such as a hardware
   wallet, following the current Farcaster documentation on adding an app key
   (docs.farcaster.xyz, "Create an account key" / signed key requests). It
   costs a small amount of OP Mainnet gas.

   > **Unverified from the build sandbox.** The contract addresses, function
   > signatures and the EIP-712 shape of the signed key request change with
   > protocol upgrades, and the protocol changed hands twice in 2026. Read the
   > current documentation before signing anything, and check the key
   > appears for your FID (Settings shows nothing about this; any Farcaster
   > client's "connected apps" list does).

3. **Give the Worker the private key, and nothing else.**

   ```bash
   npx wrangler secret put FARCASTER_SIGNER_KEY < ~/.config/blygcaster/signer.key
   ```

4. **In Settings → Farcaster**, set your FID, choose "A Snapchain hub" for
   posting, and enter a hub URL: a Snapchain node's HTTP API, normally on
   port 3381. Use a node you run, one you trust, or Neynar's hosted Snapchain
   API with `FARCASTER_HUB_API_KEY` set. There is deliberately no default.

To revoke the key, remove it from your FID with your custody wallet (or in
your Farcaster client's connected apps), then delete the secret with
`wrangler secret delete FARCASTER_SIGNER_KEY`.

## Option B: a Neynar managed signer

Quicker to set up, but Neynar holds the signing key and the signer is tied to
your Neynar API key.

1. In Neynar's developer portal, create an API key and a managed signer, and
   approve the signer from your Farcaster account when Neynar asks.
2. `wrangler secret put NEYNAR_API_KEY` and `wrangler secret put NEYNAR_SIGNER_UUID`.
3. In Settings → Farcaster, choose Neynar for posting (and for reading, if you like).

## Reading only

Reading needs no signer. With the hub backend it needs only a hub URL; with
the Neynar backend, only `NEYNAR_API_KEY`. Add accounts and channels in
Settings → Farcaster. A channel read through a hub needs the channel's parent
URL, because a hub knows channels only by that URL.

## Trying it without Farcaster

`FARCASTER_FAKE=1` switches every adapter to an in-memory fake with a few
invented demo casts, so you can try reading, stubbing and cross-posting
locally without any key or network:

```bash
npx wrangler dev --var FARCASTER_FAKE:1
```

Never set it on a deployed Worker.

## The kill switch

Settings → Farcaster → "Allow cross-posting to Farcaster". Off: nothing is
cast or deleted, whatever any item says. Casts that were waiting stay
waiting, and go out (within their retry window) when you turn it back on.
