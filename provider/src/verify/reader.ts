import { keccak_256 } from "@noble/hashes/sha3";
import type { VerifiedHeader } from "../light-client/header-source.ts";
import { bytesToHex, hexToBytes, leftPad, type Hex } from "./hex.ts";
import { ProofVerificationError, verifyAccountProof, verifyCode, verifyStorageProof, type AccountProof } from "./index.ts";

/** Sends one JSON-RPC request to an execution endpoint through the anonymous transport. */
export type JsonRpcSend = (
  method: string,
  params: unknown[],
  opts: { isolationKey: string; signal?: AbortSignal },
) => Promise<unknown>;

/** A token whose balances live in a documented `mapping(address => uint256)` storage slot. */
export interface TokenConfig {
  symbol: string;
  address: Hex;
  balanceSlot: number;
  decimals: number;
}

export interface VerifiedValue<T> {
  value: T;
  /** The light-client-verified block the value was proven against. */
  block: VerifiedHeader;
}

export interface VerifiedReader {
  getBalance(address: Hex): Promise<VerifiedValue<bigint>>;
  getTransactionCount(address: Hex): Promise<VerifiedValue<bigint>>;
  getCode(address: Hex): Promise<VerifiedValue<Hex>>;
  getStorageAt(address: Hex, slot: Hex): Promise<VerifiedValue<bigint>>;
  getTokenBalance(token: TokenConfig, holder: Hex): Promise<VerifiedValue<bigint>>;
}

/** The caller passed something DeRPC can't prove. Never counted against an operator. */
export class InputError extends Error {
  override name = "InputError";
}

/** An honest but empty or lagging answer: retry elsewhere, don't exclude the operator. */
export class EmptyAnswerError extends Error {
  override name = "EmptyAnswerError";
}

/** A structurally malformed answer: treat it like an invalid proof and exclude the operator. */
export class MalformedAnswerError extends ProofVerificationError {
  override name = "MalformedAnswerError";
}

export interface HeaderView {
  finalized(): VerifiedHeader;
  /** Throws StaleHeaderError when the block is no longer fresh. */
  assertFresh?(header: VerifiedHeader): void;
}

/**
 * Reads that only return values proven against the light client's verified finalized block.
 * Each request names that exact block, and runs under an isolation key for the account it reveals.
 */
export function createVerifiedReader(deps: { headers: HeaderView; send: JsonRpcSend }): VerifiedReader {
  const { headers, send } = deps;

  async function proveAccount(address: Hex, slots: Hex[], isolationFor: Hex) {
    const block = headers.finalized(); // throws if stale: nothing is sent
    const tag = `0x${block.blockNumber.toString(16)}`;
    const response = await send("eth_getProof", [address, slots, tag], { isolationKey: accountKey(isolationFor) });
    if (response === null || response === undefined) throw new EmptyAnswerError("eth_getProof returned no proof");
    if (typeof response !== "object") throw new MalformedAnswerError("eth_getProof returned a non-object proof");
    const account = verify(() => verifyAccountProof({ stateRoot: block.stateRoot, address, proof: response as AccountProof }));
    return { block, tag, account, response: response as AccountProof };
  }

  async function getStorageFor(address: Hex, slot: Hex, isolationFor: Hex): Promise<VerifiedValue<bigint>> {
    assertAddress(address);
    assertSlot(slot);
    const { block, account, response } = await proveAccount(address, [slot], isolationFor);
    const entry = response.storageProof?.[0];
    if (!entry) throw new MalformedAnswerError("eth_getProof returned no storage proof for the requested slot");
    const value = verify(() => verifyStorageProof({ storageRoot: account.storageRoot, slot, proof: entry }));
    headers.assertFresh?.(block);
    return { value, block };
  }

  return {
    async getBalance(address) {
      assertAddress(address);
      const { block, account } = await proveAccount(address, [], address);
      headers.assertFresh?.(block);
      return { value: account.balance, block };
    },
    async getTransactionCount(address) {
      assertAddress(address);
      const { block, account } = await proveAccount(address, [], address);
      headers.assertFresh?.(block);
      return { value: account.nonce, block };
    },
    async getCode(address) {
      assertAddress(address);
      const { block, tag, account } = await proveAccount(address, [], address);
      const code = (await send("eth_getCode", [address, tag], { isolationKey: accountKey(address) })) as Hex;
      if (code === null || code === undefined) throw new EmptyAnswerError("eth_getCode returned no code");
      if (typeof code !== "string") throw new MalformedAnswerError("eth_getCode returned a non-string code");
      verify(() => verifyCode({ codeHash: account.codeHash, code }));
      headers.assertFresh?.(block);
      return { value: code, block };
    },
    getStorageAt(address, slot) {
      return getStorageFor(address, slot, address);
    },
    async getTokenBalance(token, holder) {
      assertToken(token);
      assertAddress(holder);
      return getStorageFor(token.address, mappingSlot(holder, token.balanceSlot), holder);
    },
  };
}

/** Verify-shaped work: genuine proof failures stay as they are; shape errors become invalid answers. */
function verify<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ProofVerificationError) throw error;
    throw new MalformedAnswerError(error instanceof Error ? error.message : String(error));
  }
}

export function assertAddress(value: Hex, label = "address"): void {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new InputError(`expected ${label} as a 20-byte hex string, got ${JSON.stringify(value)}`);
  }
}

/** Accepts a quantity-shaped storage slot of up to 32 bytes. */
export function assertSlot(value: Hex): void {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new InputError(`expected a storage slot (hex, up to 32 bytes), got ${JSON.stringify(value)}`);
  }
}

export function assertToken(token: TokenConfig): void {
  if (!token || typeof token !== "object") throw new InputError("expected a token configuration");
  assertAddress(token.address, "token address");
  if (!Number.isSafeInteger(token.balanceSlot) || token.balanceSlot < 0) {
    throw new InputError(`expected a non-negative balance slot, got ${JSON.stringify(token.balanceSlot)}`);
  }
}

/** One isolation key per account the request reveals, so different accounts' reads aren't linkable. */
function accountKey(address: Hex): string {
  return `derpc:account:${address.toLowerCase()}`;
}

/** Storage slot of `mapping[holder]` for a mapping declared at `slot`: keccak256(pad32(holder) ‖ pad32(slot)). */
export function mappingSlot(holder: Hex, slot: number): Hex {
  assertAddress(holder, "holder");
  if (!Number.isSafeInteger(slot) || slot < 0) throw new InputError(`expected a non-negative balance slot, got ${JSON.stringify(slot)}`);
  const digits = BigInt(slot).toString(16);
  if (digits.length > 64) throw new InputError(`balance slot ${slot} does not fit in 32 bytes`);
  const hex = `0x${digits.length % 2 === 0 ? digits : `0${digits}`}` as Hex;
  const key = new Uint8Array(64);
  key.set(leftPad(hexToBytes(holder), 32), 0);
  key.set(leftPad(hexToBytes(hex), 32), 32);
  return bytesToHex(keccak_256(key));
}
