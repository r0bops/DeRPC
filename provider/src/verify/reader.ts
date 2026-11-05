import { keccak_256 } from "@noble/hashes/sha3";
import type { VerifiedHeader } from "../light-client/header-source.ts";
import { bytesToHex, hexToBytes, leftPad, type Hex } from "./hex.ts";
import { ProofVerificationError, verifyAccountProof, verifyCode, verifyStorageProof, type AccountProof } from "./index.ts";

/** Sends one JSON-RPC request to an execution endpoint through the anonymous transport. */
export type JsonRpcSend = (method: string, params: unknown[], opts: { isolationKey: string }) => Promise<unknown>;

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

/**
 * Reads that only return values proven against the light client's verified finalized block.
 * Each request names that exact block, and runs under an isolation key for the account it reveals.
 */
export function createVerifiedReader(deps: { headers: { finalized(): VerifiedHeader }; send: JsonRpcSend }): VerifiedReader {
  const { headers, send } = deps;

  async function proveAccount(address: Hex, slots: Hex[], isolationFor: Hex) {
    const block = headers.finalized(); // throws if stale: nothing is sent
    const tag = `0x${block.blockNumber.toString(16)}`;
    const response = (await send("eth_getProof", [address, slots, tag], { isolationKey: accountKey(isolationFor) })) as AccountProof;
    if (!response || typeof response !== "object") throw new ProofVerificationError("eth_getProof returned no proof");
    const account = verifyAccountProof({ stateRoot: block.stateRoot, address, proof: response });
    return { block, tag, account, response };
  }

  async function getStorageFor(address: Hex, slot: Hex, isolationFor: Hex): Promise<VerifiedValue<bigint>> {
    const { block, account, response } = await proveAccount(address, [slot], isolationFor);
    const entry = response.storageProof?.[0];
    if (!entry) throw new ProofVerificationError("eth_getProof returned no storage proof for the requested slot");
    return { value: verifyStorageProof({ storageRoot: account.storageRoot, slot, proof: entry }), block };
  }

  return {
    async getBalance(address) {
      const { block, account } = await proveAccount(address, [], address);
      return { value: account.balance, block };
    },
    async getTransactionCount(address) {
      const { block, account } = await proveAccount(address, [], address);
      return { value: account.nonce, block };
    },
    async getCode(address) {
      const { block, tag, account } = await proveAccount(address, [], address);
      const code = (await send("eth_getCode", [address, tag], { isolationKey: accountKey(address) })) as Hex;
      if (typeof code !== "string") throw new ProofVerificationError("eth_getCode returned no code");
      verifyCode({ codeHash: account.codeHash, code });
      return { value: code, block };
    },
    getStorageAt(address, slot) {
      return getStorageFor(address, slot, address);
    },
    getTokenBalance(token, holder) {
      return getStorageFor(token.address, mappingSlot(holder, token.balanceSlot), holder);
    },
  };
}

/** One isolation key per account the request reveals, so different accounts' reads aren't linkable. */
function accountKey(address: Hex): string {
  return `derpc:account:${address.toLowerCase()}`;
}

/** Storage slot of `mapping[holder]` for a mapping declared at `slot`: keccak256(pad32(holder) ‖ pad32(slot)). */
export function mappingSlot(holder: Hex, slot: number): Hex {
  const key = new Uint8Array(64);
  key.set(leftPad(hexToBytes(holder), 32), 0);
  key.set(leftPad(hexToBytes(`0x${slot.toString(16).padStart(2, "0")}`), 32), 32);
  return bytesToHex(keccak_256(key));
}
