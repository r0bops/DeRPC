import type { VerifiedHeader } from "../light-client/header-source.ts";
import { createVerifiedReader, type VerifiedReader, type VerifiedValue } from "../verify/reader.ts";
import type { Pool } from "./pool.ts";

const CACHE_LIMIT = 256;

/**
 * Verified reads served by the pool: each read runs on one endpoint at a time and moves to another
 * when an answer fails verification or an attempt fails. Verified results are cached by the verified
 * block's hash and the request, on the device only.
 */
export function createPooledReader(deps: { headers: { finalized(): VerifiedHeader }; pool: Pool }): VerifiedReader {
  const { headers, pool } = deps;
  const cache = new Map<string, VerifiedValue<unknown>>();

  function cached<A extends unknown[], T>(name: keyof VerifiedReader, read: (reader: VerifiedReader, ...args: A) => Promise<VerifiedValue<T>>) {
    return async (...args: A): Promise<VerifiedValue<T>> => {
      const block = headers.finalized(); // throws if stale, before anything is sent
      const key = `${block.blockHash}|${name}|${JSON.stringify(args).toLowerCase()}`;
      const hit = cache.get(key);
      if (hit) return hit as VerifiedValue<T>;
      const result = await pool.run((send) => read(createVerifiedReader({ headers, send }), ...args));
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      cache.set(key, result);
      return result;
    };
  }

  return {
    getBalance: cached("getBalance", (r, address: `0x${string}`) => r.getBalance(address)),
    getTransactionCount: cached("getTransactionCount", (r, address: `0x${string}`) => r.getTransactionCount(address)),
    getCode: cached("getCode", (r, address: `0x${string}`) => r.getCode(address)),
    getStorageAt: cached("getStorageAt", (r, address: `0x${string}`, slot: `0x${string}`) => r.getStorageAt(address, slot)),
    getTokenBalance: cached("getTokenBalance", (r, token: Parameters<VerifiedReader["getTokenBalance"]>[0], holder: `0x${string}`) =>
      r.getTokenBalance(token, holder),
    ),
  };
}
