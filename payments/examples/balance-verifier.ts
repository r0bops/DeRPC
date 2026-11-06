import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";
import { verifyAccountProof, type AccountProof } from "../../provider/src/verify/index.ts";
import type { VerifiedHeader } from "../../provider/src/light-client/header-source.ts";

/** Both the browser and sponsor hash the exact supported request/result/block tuple. */
export function balanceReadHash(address: Address, blockHash: Hex, value: bigint): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }],
    [1n, keccak256(stringToHex("eth_getBalance")), address, blockHash, value],
  ));
}

/**
 * Minimal supported-read evidence verifier for the coordinator example. The application must
 * supply its authenticated, freshness-enforcing header source; evidence never supplies a root.
 * This function performs no network IO. Transport/runtime setup remains the application's job.
 */
export function createBalanceEvidenceVerifier(options: {
  headers: { finalized(): VerifiedHeader; assertFresh(header: VerifiedHeader): void };
  price: bigint;
}) {
  if (options.price <= 0n || options.price >= 1n << 256n) throw new Error("invalid frozen balance price");
  const { headers, price } = options;
  return async (evidence: unknown, control?: { signal?: AbortSignal }): Promise<{ readHash: Hex; charge: bigint }> => {
    control?.signal?.throwIfAborted();
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("missing balance evidence");
    const input = evidence as Record<string, unknown>;
    if (input.method !== "eth_getBalance" || typeof input.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input.address) || typeof input.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.blockHash) || typeof input.value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(input.value) || !input.proof || typeof input.proof !== "object") throw new Error("invalid balance evidence");
    const block = headers.finalized();
    if (block.network !== "mainnet" || block.blockHash.toLowerCase() !== input.blockHash.toLowerCase()) throw new Error("evidence does not name the authenticated mainnet finalized block");
    headers.assertFresh(block);
    const address = input.address as Address;
    const account = verifyAccountProof({ stateRoot: block.stateRoot, address, proof: input.proof as AccountProof });
    if (account.balance !== BigInt(input.value)) throw new Error("balance result does not match its proof");
    headers.assertFresh(block);
    control?.signal?.throwIfAborted();
    return { readHash: balanceReadHash(address, block.blockHash, account.balance), charge: price };
  };
}
