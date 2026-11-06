import { createMPT, createMerkleProof, type MerklePatriciaTrie } from "@ethereumjs/mpt";
import { Account } from "@ethereumjs/util";
import { keccak256, toRlp } from "viem";
import type { VerifiedHeader } from "../../src/light-client/header-source.ts";
import type { AccountProof } from "../../src/verify/index.ts";
import { bytesToHex, hexToBytes, type Hex } from "../../src/verify/hex.ts";
import type { JsonRpcSend } from "../../src/verify/reader.ts";

export const TARGET: Hex = "0x1111111111111111111111111111111111111111";
export const IMPLEMENTATION: Hex = "0x2222222222222222222222222222222222222222";
export const THIRD: Hex = "0x3333333333333333333333333333333333333333";
export const ZERO: Hex = `0x${"00".repeat(20)}`;
export const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`;
const quantity = (value: bigint): Hex => `0x${value.toString(16)}`;
const scalar = (value: bigint): Hex => value === 0n ? "0x" : `0x${value.toString(16).padStart(Math.ceil(value.toString(16).length / 2) * 2, "0")}`;

export interface FixtureAccount {
  address: Hex;
  code?: Hex;
  balance?: bigint;
  nonce?: bigint;
  storage?: Record<string, bigint>;
}

export interface RecordedRequest {
  method: string;
  params: unknown[];
  isolationKey: string;
  signal?: AbortSignal;
}

/** Builds genuine secure state/storage tries. The executor still uses DeRPC's independent verifier. */
export async function provenFixture(input: FixtureAccount[]) {
  const state = await createMPT({ useKeyHashing: true });
  const emptyStorage = await createMPT({ useKeyHashing: true });
  const accounts = new Map<string, {
    account: Account;
    code: Hex;
    storage: MerklePatriciaTrie;
    slots: Map<string, bigint>;
  }>();
  for (const spec of input) {
    const storage = await createMPT({ useKeyHashing: true });
    const slots = new Map<string, bigint>();
    for (const [key, value] of Object.entries(spec.storage ?? {})) {
      const slot = word(BigInt(key));
      slots.set(slot, value);
      // Ethereum omits zero-valued slots; a zero result requires a non-membership proof.
      if (value !== 0n) await storage.put(hexToBytes(slot), hexToBytes(toRlp(scalar(value))));
    }
    const code = spec.code ?? "0x";
    const account = new Account(spec.nonce ?? 0n, spec.balance ?? 0n, storage.root(), hexToBytes(keccak256(code)));
    await state.put(hexToBytes(spec.address), account.serialize());
    accounts.set(spec.address.toLowerCase(), { account, code, storage, slots });
  }
  const block: VerifiedHeader = {
    network: "mainnet",
    slot: 11_000_000,
    blockNumber: 22_500_000,
    blockHash: `0x${"ab".repeat(32)}`,
    stateRoot: bytesToHex(state.root()),
    timestamp: 1_750_000_000, // Prague: includes EIP-7702 and authenticated post-merge context.
    execution: {
      feeRecipient: "0x4444444444444444444444444444444444444444",
      prevRandao: `0x${"bc".repeat(32)}`,
      gasLimit: 36_000_000n,
      baseFeePerGas: 17_000_000_000n,
      excessBlobGas: 0n,
    },
  };
  const calls: RecordedRequest[] = [];
  async function proof(address: Hex, requested: Hex[]): Promise<AccountProof> {
    const found = accounts.get(address.toLowerCase());
    const account = found?.account ?? new Account();
    const storage = found?.storage ?? emptyStorage;
    return {
      address,
      balance: quantity(account.balance),
      nonce: quantity(account.nonce),
      codeHash: bytesToHex(account.codeHash),
      storageHash: bytesToHex(account.storageRoot),
      accountProof: (await createMerkleProof(state, hexToBytes(address))).map(bytesToHex),
      storageProof: await Promise.all(requested.map(async slot => ({
        key: slot,
        value: quantity(found?.slots.get(word(BigInt(slot))) ?? 0n),
        proof: (await createMerkleProof(storage, hexToBytes(word(BigInt(slot))))).map(bytesToHex),
      }))),
    };
  }
  function endpoint(intercept?: (request: RecordedRequest, response: unknown) => unknown | Promise<unknown>): JsonRpcSend {
    return async (method, params, opts) => {
      const request = { method, params, ...opts };
      calls.push(request);
      const tag = quantity(BigInt(block.blockNumber));
      if (params.at(-1) !== tag) throw new Error("fixture refused an unpinned block request");
      let response: unknown;
      if (method === "eth_getProof") response = await proof(params[0] as Hex, params[1] as Hex[]);
      else if (method === "eth_getCode") response = accounts.get((params[0] as Hex).toLowerCase())?.code ?? "0x";
      else throw new Error(`fixture refuses unsupported remote method ${method}`);
      return intercept ? intercept(request, response) : response;
    };
  }
  return { block, calls, proof, endpoint, headers: { finalized: () => block } };
}

export const LOAD_SLOT_ZERO: Hex = "0x60005460005260206000f3";
export const RETURN_42: Hex = "0x602a60005260206000f3";

/** Hand-assembled delegate call, deliberately discarding failure so integrity errors must escape it. */
export function delegateThen(target: Hex, suffix = "60206000f3"): Hex {
  // outSize, outOffset, inSize, inOffset, target, gas, DELEGATECALL, POP, suffix.
  return `0x602060006000600073${target.slice(2)}5af450${suffix}`;
}
