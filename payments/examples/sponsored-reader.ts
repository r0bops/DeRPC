import type { Address, Hex } from "viem";
import type { VerifiedHeader } from "../../provider/src/light-client/header-source.ts";
import { verifyAccountProof, verifyCode, verifyStorageProof, type AccountProof } from "../../provider/src/verify/index.ts";
import type { JsonRpcSend } from "../../provider/src/verify/reader.ts";
import type { SignedVoucher } from "../src/protocol.ts";
import { SponsoredPaymentClient, type SignedSponsoredIntent } from "../src/sponsored-client.ts";
import { sponsoredRequestHash, type SponsoredReadEvidence, type SponsoredReadRequest } from "./read-evidence.ts";

export interface SponsoredReadControl {
  /** Allocate each nonce once. Recover uncertain outcomes with the retained signed intent. */
  nonce: bigint;
  expiresAt: number;
  signal?: AbortSignal;
  /** Optional app persistence hook, called before the coordinator sees the signed intent. */
  persistIntent?: (intent: SignedSponsoredIntent) => Promise<void> | void;
}
export interface SponsoredVerifiedValue<T> {
  value: T;
  block: VerifiedHeader;
  voucher: SignedVoucher;
  readId: Hex;
}

/** Retains verified evidence for retryComplete after an uncertain acknowledgement. Contains read data. */
export class SponsoredReaderError extends Error {
  override name = "SponsoredReaderError";
  readonly recovery: SignedSponsoredIntent;
  readonly evidence?: SponsoredReadEvidence;
  constructor(cause: unknown, recovery: SignedSponsoredIntent, evidence?: SponsoredReadEvidence) {
    super(cause instanceof Error ? cause.message : "sponsored read failed", { cause });
    this.recovery = recovery;
    this.evidence = evidence;
  }
}

/**
 * Browser-host example for one operator. Supply a tested anonymous JSON-RPC transport and an
 * authenticated header source. The app's escrow key lives only in its coordinator, never here.
 */
export function createSponsoredReader(options: {
  client: SponsoredPaymentClient;
  headers: { finalized(): VerifiedHeader; assertFresh(header: VerifiedHeader): void };
  send: JsonRpcSend;
}) {
  const { client, headers, send } = options;
  async function read(request: SponsoredReadRequest, control: SponsoredReadControl): Promise<SponsoredVerifiedValue<bigint | Hex>> {
    control.signal?.throwIfAborted();
    const block = { ...headers.finalized() };
    if (block.network !== "mainnet") throw new Error("sponsored reader requires authenticated mainnet headers");
    headers.assertFresh(block);
    request = { ...request };
    const requestHash = sponsoredRequestHash(request, block.blockHash);
    const prepared = await client.prepare({
      nonce: control.nonce, kind: request.method === "eth_getCode" ? "code" : "proof",
      requestHash, expiresAt: control.expiresAt,
    }, control);
    let evidence: SponsoredReadEvidence | undefined;
    try {
      await control.persistIntent?.(prepared);
      control.signal?.throwIfAborted();
      const attempt = await client.retryBegin(prepared, control);
      control.signal?.throwIfAborted();
      headers.assertFresh(block);
      const rpcOptions = () => {
        control.signal?.throwIfAborted();
        headers.assertFresh(block);
        return { isolationKey: `derpc:account:${request.address.toLowerCase()}`, signal: control.signal, headers: attempt.headers() };
      };
      const tag = `0x${block.blockNumber.toString(16)}`;
      const slots = request.method === "eth_getStorageAt" ? [request.slot!] : [];
      const response = await send("eth_getProof", [request.address, slots, tag], rpcOptions());
      control.signal?.throwIfAborted();
      if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("missing sponsored account proof");
      const proof = response as AccountProof;
      const account = verifyAccountProof({ stateRoot: block.stateRoot, address: request.address, proof });
      let value: bigint | Hex;
      if (request.method === "eth_getCode") {
        const code = await send("eth_getCode", [request.address, tag], rpcOptions());
        control.signal?.throwIfAborted();
        if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw new Error("invalid sponsored code response");
        verifyCode({ codeHash: account.codeHash, code: code as Hex });
        value = code as Hex;
      } else if (request.method === "eth_getStorageAt") {
        const entry = proof.storageProof?.find(item => BigInt(item.key) === BigInt(request.slot!));
        if (!entry) throw new Error("missing sponsored storage proof");
        value = verifyStorageProof({ storageRoot: account.storageRoot, slot: request.slot!, proof: entry });
      } else value = request.method === "eth_getBalance" ? account.balance : account.nonce;
      headers.assertFresh(block);
      control.signal?.throwIfAborted();
      evidence = { ...request, blockHash: block.blockHash, proof, value: value.toString(), ...(request.method === "eth_getCode" ? { code: value as Hex } : {}) };
      const voucher = await attempt.complete(evidence, control);
      control.signal?.throwIfAborted();
      headers.assertFresh(block);
      return { value, block, voucher, readId: attempt.readId };
    } catch (error) { throw new SponsoredReaderError(error, prepared, evidence); }
  }
  const scalar = async (request: SponsoredReadRequest, control: SponsoredReadControl): Promise<SponsoredVerifiedValue<bigint>> => {
    const result = await read(request, control);
    return { ...result, value: result.value as bigint };
  };
  return {
    read,
    getBalance: (address: Address, control: SponsoredReadControl) => scalar({ method: "eth_getBalance", address }, control),
    getTransactionCount: (address: Address, control: SponsoredReadControl) => scalar({ method: "eth_getTransactionCount", address }, control),
    getStorageAt: (address: Address, slot: Hex, control: SponsoredReadControl) => scalar({ method: "eth_getStorageAt", address, slot }, control),
    getCode: async (address: Address, control: SponsoredReadControl): Promise<SponsoredVerifiedValue<Hex>> => {
      const result = await read({ method: "eth_getCode", address }, control);
      return { ...result, value: result.value as Hex };
    },
  };
}
