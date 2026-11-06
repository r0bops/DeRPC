import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";
import { verifyAccountProof, verifyCode, verifyStorageProof, type AccountProof } from "../../provider/src/verify/index.ts";
import type { VerifiedHeader } from "../../provider/src/light-client/header-source.ts";
import type { ReadKind } from "../src/protocol.ts";

export interface SponsoredReadRequest {
  method: "eth_getBalance" | "eth_getTransactionCount" | "eth_getStorageAt" | "eth_getCode";
  address: Address;
  slot?: Hex;
}
export interface SponsoredReadEvidence extends SponsoredReadRequest {
  blockHash: Hex;
  proof: AccountProof;
  /** Decimal scalar value or complete hex bytecode. */
  value: string;
  code?: Hex;
}

/** Canonical mainnet request intent: chain, full method, account, slot and authenticated block. */
export function sponsoredRequestHash(request: SponsoredReadRequest, blockHash: Hex): Hex {
  validateRequest(request);
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
    [1n, keccak256(stringToHex(request.method)), request.address, request.slot ? BigInt(request.slot) : 0n, blockHash],
  ));
}

/** Rechecks evidence against the sponsor's OWN authenticated header view; no network IO. */
export function createReadEvidenceVerifier(options: {
  headers: { finalized(): VerifiedHeader; assertFresh(header: VerifiedHeader): void };
  price: bigint;
}) {
  if (options.price <= 0n || options.price >= 1n << 256n) throw new Error("invalid frozen sponsored price");
  const { headers, price } = options;
  return async (evidence: unknown, control?: { signal?: AbortSignal; intent?: { kind: ReadKind } }): Promise<{ requestHash: Hex; readHash: Hex; charge: bigint }> => {
    control?.signal?.throwIfAborted();
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("missing sponsored evidence");
    const input = evidence as SponsoredReadEvidence;
    validateRequest(input);
    if (typeof input.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.blockHash) || !input.proof || typeof input.proof !== "object" || typeof input.value !== "string") throw new Error("invalid sponsored evidence");
    const kind: ReadKind = input.method === "eth_getCode" ? "code" : "proof";
    if (control?.intent && control.intent.kind !== kind) throw new Error("sponsored evidence does not match its authorized read kind");
    const block = headers.finalized();
    if (block.network !== "mainnet" || block.blockHash.toLowerCase() !== input.blockHash.toLowerCase()) throw new Error("evidence does not name the authenticated mainnet finalized block");
    headers.assertFresh(block);
    const account = verifyAccountProof({ stateRoot: block.stateRoot, address: input.address, proof: input.proof });
    let result: Hex;
    if (input.method === "eth_getCode") {
      if (typeof input.code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input.code) || input.code.toLowerCase() !== input.value.toLowerCase()) throw new Error("invalid code result");
      verifyCode({ codeHash: account.codeHash, code: input.code });
      result = keccak256(input.code);
    } else {
      if (!/^(0|[1-9]\d{0,77})$/.test(input.value)) throw new Error("invalid scalar result");
      let value: bigint;
      if (input.method === "eth_getStorageAt") {
        const proof = input.proof.storageProof?.find(item => BigInt(item.key) === BigInt(input.slot!));
        if (!proof) throw new Error("missing sponsored storage proof");
        value = verifyStorageProof({ storageRoot: account.storageRoot, slot: input.slot!, proof });
      } else value = input.method === "eth_getBalance" ? account.balance : account.nonce;
      if (value !== BigInt(input.value)) throw new Error("sponsored result does not match its proof");
      result = keccak256(encodeAbiParameters([{ type: "uint256" }], [value]));
    }
    headers.assertFresh(block);
    control?.signal?.throwIfAborted();
    const requestHash = sponsoredRequestHash(input, block.blockHash);
    return { requestHash, readHash: keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [requestHash, result])), charge: price };
  };
}

function validateRequest(request: SponsoredReadRequest): void {
  if (!request || !["eth_getBalance", "eth_getTransactionCount", "eth_getStorageAt", "eth_getCode"].includes(request.method) || typeof request.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(request.address)) throw new Error("invalid sponsored read request");
  if (request.method === "eth_getStorageAt") {
    if (typeof request.slot !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(request.slot)) throw new Error("invalid sponsored storage slot");
  } else if (request.slot !== undefined) throw new Error("unexpected sponsored storage slot");
}
