// The hand-written message encoder against @farcaster/core 0.21.0's own
// output (scripts/farcaster-golden-vectors.mjs). If a byte differs, a hub
// would compute a different hash and reject the signature.
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-messages.json";
import { bytesToHex, castAddData, castRemoveData, ed25519Signer, signMessage } from "../../src/farcaster/message.ts";
import { fromFarcasterTime, toFarcasterTime } from "../../src/farcaster/normalize.ts";

const at = new Date(fromFarcasterTime(golden.dataOptions.timestamp));

describe("Farcaster message encoding", () => {
  it("round-trips Farcaster time", () => {
    expect(toFarcasterTime(at)).toBe(golden.dataOptions.timestamp);
  });

  it("derives the same public key from the signer key", async () => {
    const signer = await ed25519Signer(golden.privateKey);
    expect(bytesToHex(signer.publicKey)).toBe(golden.castAdds[0].signer);
  });

  for (const v of golden.castAdds) {
    it(`matches @farcaster/core byte for byte: ${v.name}`, async () => {
      const input = v.input as { text: string; embeds: string[]; parentUrl?: string; parentCastId?: { fid: number; hash: string } };
      const data = castAddData(golden.dataOptions.fid, at, { text: input.text, embeds: input.embeds, parentUrl: input.parentUrl, parent: input.parentCastId });
      expect(bytesToHex(data)).toBe(v.dataBytes);
      const signed = await signMessage(data, await ed25519Signer(golden.privateKey));
      expect(signed.hash).toBe(v.hash);
      expect(bytesToHex(signed.bytes)).toBe(v.message);
    });
  }

  it("matches @farcaster/core byte for byte: a CastRemove", async () => {
    const v = golden.castRemoves[0];
    const data = castRemoveData(golden.dataOptions.fid, at, v.input.targetHash);
    expect(bytesToHex(data)).toBe(v.dataBytes);
    const signed = await signMessage(data, await ed25519Signer(golden.privateKey));
    expect(signed.hash).toBe(v.hash);
    expect(bytesToHex(signed.bytes)).toBe(v.message);
  });

  it("is deterministic, so a retry resubmits the same message", async () => {
    const signer = await ed25519Signer(golden.privateKey);
    const data = () => castAddData(1, at, { text: "same", embeds: [] });
    expect((await signMessage(data(), signer)).hash).toBe((await signMessage(data(), signer)).hash);
  });

  it("refuses a malformed signer key without echoing it", async () => {
    await expect(ed25519Signer("not-a-key")).rejects.toThrow("FARCASTER_SIGNER_KEY must be 32 bytes of hex");
    await expect(ed25519Signer("0x" + "ab".repeat(31))).rejects.not.toThrow(/abab/);
  });
});
