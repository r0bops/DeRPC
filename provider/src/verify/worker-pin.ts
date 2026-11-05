import type { WorkerPin } from "../config/mainnet.ts";
import type { HeaderNetwork, VerifiedHeader } from "../light-client/header-source.ts";
import type { Hex } from "./hex.ts";
import type { VerifiedReader } from "./reader.ts";

/** Storage slot of `workerHash` in the reference WorkerSpecifier: owner(0), workerHash(1), resolvers(2). */
export const WORKER_HASH_SLOT: Hex = "0x1";

export class WorkerPinMismatchError extends Error {
  override name = "WorkerPinMismatchError";
}
export class WorkerPinChainError extends Error {
  override name = "WorkerPinChainError";
}

/**
 * Prove that the specifier contract's on-chain workerHash equals the local pin the worker booted from.
 * This is what makes the pin trusted: agreement at the verified block (not instant knowledge of a
 * later owner update). The pin is never replaced automatically; a mismatch stops everything.
 */
export async function checkWorkerPin(args: {
  pin: WorkerPin;
  network: HeaderNetwork;
  reader: VerifiedReader;
}): Promise<{ workerHash: Hex; block: VerifiedHeader }> {
  const { pin, network, reader } = args;
  if (pin.chain !== network) {
    throw new WorkerPinChainError(`${pin.name}'s specifier is on ${pin.chain}; it can't be verified against ${network} state`);
  }
  const { value, block } = await reader.getStorageAt(pin.specifier, WORKER_HASH_SLOT);
  const onChain = `0x${value.toString(16).padStart(64, "0")}` as Hex;
  if (onChain !== pin.workerHash.toLowerCase()) {
    throw new WorkerPinMismatchError(
      `on-chain workerHash ${onChain} (block ${block.blockNumber}) differs from the pinned ${pin.workerHash}; refusing to serve reads`,
    );
  }
  return { workerHash: onChain, block };
}

/** Hold every read until `check` resolves; if it rejects, refuse every read with its error. */
export function gateReader(reader: VerifiedReader, check: Promise<unknown>): VerifiedReader {
  check.catch(() => {}); // the failure is reported through every read instead
  const gated: Record<string, unknown> = {};
  for (const name of Object.keys(reader) as (keyof VerifiedReader)[]) {
    const method = reader[name] as (...args: unknown[]) => Promise<unknown>;
    gated[name] = async (...args: unknown[]) => {
      await check;
      return method(...args);
    };
  }
  return gated as unknown as VerifiedReader;
}
