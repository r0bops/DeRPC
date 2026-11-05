// EIP-1186 proof verification against a state root. The fixture is a real mainnet eth_getProof
// response at one block; expected values come from independent RPC calls recorded alongside it
// (eth_getBalance, eth_getTransactionCount, eth_call balanceOf), never from the verifier.
import { describe, expect, it } from "vitest";
import {
  ProofVerificationError,
  verifyAccountProof,
  verifyCode,
  verifyStorageProof,
  type AccountProof,
} from "../../src/verify/index.ts";
import fixture from "../fixtures/mainnet-proofs.json" with { type: "json" };

type Hex = `0x${string}`;
const STATE_ROOT = fixture.block.stateRoot as Hex;
const { HOLDER, WETH, NONEXISTENT, holderSlot, noWethSlot } = fixture.inputs;
const clone = <T>(v: T): T => structuredClone(v);
const holderProof = () => clone(fixture.responses.holderAccount) as AccountProof;
const wethProof = () => clone(fixture.responses.wethWithSlots) as AccountProof;
const absentProof = () => clone(fixture.responses.nonexistentAccount) as AccountProof;
const flipLastByte = (hex: string) => hex.slice(0, -2) + (hex.endsWith("00") ? "01" : "00");

describe("verifyAccountProof", () => {
  it("returns the proven balance and nonce of an existing account", () => {
    const account = verifyAccountProof({ stateRoot: STATE_ROOT, address: HOLDER as Hex, proof: holderProof() });

    expect(account.exists).toBe(true);
    expect(account.balance).toBe(BigInt(fixture.reference.holderBalance));
    expect(account.nonce).toBe(BigInt(fixture.reference.holderNonce));
  });

  it("proves that an account does not exist", () => {
    const account = verifyAccountProof({ stateRoot: STATE_ROOT, address: NONEXISTENT as Hex, proof: absentProof() });

    expect(account).toMatchObject({ exists: false, balance: 0n, nonce: 0n });
  });

  it("rejects a claimed balance that differs from the proven one", () => {
    const proof = holderProof();
    proof.balance = "0xde0b6b3a7640000"; // claims 1 ETH

    expect(() => verifyAccountProof({ stateRoot: STATE_ROOT, address: HOLDER as Hex, proof })).toThrow(ProofVerificationError);
  });

  it("rejects a non-zero balance claimed for an account that does not exist", () => {
    const proof = absentProof();
    proof.balance = "0xde0b6b3a7640000";

    expect(() => verifyAccountProof({ stateRoot: STATE_ROOT, address: NONEXISTENT as Hex, proof })).toThrow(ProofVerificationError);
  });

  it("rejects a tampered proof node", () => {
    const proof = holderProof();
    proof.accountProof[proof.accountProof.length - 1] = flipLastByte(proof.accountProof.at(-1)!) as Hex;

    expect(() => verifyAccountProof({ stateRoot: STATE_ROOT, address: HOLDER as Hex, proof })).toThrow(ProofVerificationError);
  });

  it("rejects a valid proof checked against a different state root", () => {
    expect(() => verifyAccountProof({ stateRoot: fixture.block.hash as Hex, address: HOLDER as Hex, proof: holderProof() })).toThrow(
      ProofVerificationError,
    );
  });

  it("rejects a proof for a different address than the one requested", () => {
    expect(() => verifyAccountProof({ stateRoot: STATE_ROOT, address: WETH as Hex, proof: holderProof() })).toThrow(ProofVerificationError);
  });

  it("rejects a truncated proof", () => {
    const proof = holderProof();
    proof.accountProof = proof.accountProof.slice(0, -1);

    expect(() => verifyAccountProof({ stateRoot: STATE_ROOT, address: HOLDER as Hex, proof })).toThrow(ProofVerificationError);
  });

  it("rejects a truncated proof that claims the account does not exist (hiding a real balance)", () => {
    const proof = holderProof();
    proof.accountProof = proof.accountProof.slice(0, -1);
    Object.assign(proof, { balance: "0x0", nonce: "0x0", codeHash: `0x${"00".repeat(32)}`, storageHash: `0x${"00".repeat(32)}` });

    expect(() => verifyAccountProof({ stateRoot: STATE_ROOT, address: HOLDER as Hex, proof })).toThrow(ProofVerificationError);
  });

  it("rejects extra nodes after the proof is complete", () => {
    const proof = holderProof();
    proof.accountProof = [...proof.accountProof, proof.accountProof[0]!];

    expect(() => verifyAccountProof({ stateRoot: STATE_ROOT, address: HOLDER as Hex, proof })).toThrow(ProofVerificationError);
  });
});

describe("verifyStorageProof", () => {
  const wethStorageRoot = () => verifyAccountProof({ stateRoot: STATE_ROOT, address: WETH as Hex, proof: wethProof() }).storageRoot;
  const entry = (i: number) => wethProof().storageProof[i]!;

  it("returns the proven value of a storage slot (the holder's WETH balance)", () => {
    const value = verifyStorageProof({ storageRoot: wethStorageRoot(), slot: holderSlot as Hex, proof: entry(0) });

    expect(value).toBe(BigInt(fixture.reference.holderWethBalanceOf));
  });

  it("proves that an unset slot is zero", () => {
    expect(verifyStorageProof({ storageRoot: wethStorageRoot(), slot: noWethSlot as Hex, proof: entry(1) })).toBe(0n);
  });

  it("rejects a claimed slot value that differs from the proven one", () => {
    const tampered = { ...entry(0), value: "0x1" as Hex };

    expect(() => verifyStorageProof({ storageRoot: wethStorageRoot(), slot: holderSlot as Hex, proof: tampered })).toThrow(ProofVerificationError);
  });

  it("rejects a slot proof checked against another account's storage root", () => {
    expect(() => verifyStorageProof({ storageRoot: STATE_ROOT, slot: holderSlot as Hex, proof: entry(0) })).toThrow(ProofVerificationError);
  });

  it("rejects a proof for a different slot than the one requested", () => {
    expect(() => verifyStorageProof({ storageRoot: wethStorageRoot(), slot: noWethSlot as Hex, proof: entry(0) })).toThrow(ProofVerificationError);
  });
});

describe("verifyCode", () => {
  const codeHash = () => verifyAccountProof({ stateRoot: STATE_ROOT, address: WETH as Hex, proof: wethProof() }).codeHash;

  it("accepts code that hashes to the proven code hash", () => {
    expect(() => verifyCode({ codeHash: codeHash(), code: fixture.responses.wethCode as Hex })).not.toThrow();
  });

  it("rejects altered code", () => {
    expect(() => verifyCode({ codeHash: codeHash(), code: flipLastByte(fixture.responses.wethCode) as Hex })).toThrow(ProofVerificationError);
  });
});
