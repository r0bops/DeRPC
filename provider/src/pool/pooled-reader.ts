import type { VerifiedHeader } from "../light-client/header-source.ts";
import {
  assertAddress,
  assertSlot,
  assertToken,
  createVerifiedReader,
  type VerifiedReader,
  type VerifiedValue,
} from "../verify/reader.ts";
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

  // `accountOf` names the account a read reveals, so the pool keeps that account on one operator.
  function cached<A extends unknown[], T>(
    name: keyof VerifiedReader,
    accountOf: (...args: A) => string,
    read: (reader: VerifiedReader, ...args: A) => Promise<VerifiedValue<T>>,
    validate?: (...args: A) => void,
  ) {
    return async (...args: A): Promise<VerifiedValue<T>> => {
      validate?.(...args); // caller errors never reach an operator
      const block = headers.finalized(); // throws if stale, before anything is sent
      const key = `${block.blockHash}|${name}|${JSON.stringify(args).toLowerCase()}`;
      const hit = cache.get(key);
      if (hit) return hit as VerifiedValue<T>;
      const result = await pool.run((send) => read(createVerifiedReader({ headers, send }), ...args), { account: accountOf(...args) });
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      cache.set(key, result);
      return result;
    };
  }

  return {
    getBalance: cached(
      "getBalance",
      (address) => address,
      (r, address: `0x${string}`) => r.getBalance(address),
      (address) => assertAddress(address),
    ),
    getTransactionCount: cached(
      "getTransactionCount",
      (address) => address,
      (r, address: `0x${string}`) => r.getTransactionCount(address),
      (address) => assertAddress(address),
    ),
    getCode: cached(
      "getCode",
      (address) => address,
      (r, address: `0x${string}`) => r.getCode(address),
      (address) => assertAddress(address),
    ),
    getStorageAt: cached(
      "getStorageAt",
      (address: `0x${string}`, _slot: `0x${string}`) => address,
      (r, address: `0x${string}`, slot: `0x${string}`) => r.getStorageAt(address, slot),
      (address, slot) => {
        assertAddress(address);
        assertSlot(slot);
      },
    ),
    getTokenBalance: cached(
      "getTokenBalance",
      (_token, holder) => holder,
      (r, token: Parameters<VerifiedReader["getTokenBalance"]>[0], holder: `0x${string}`) => r.getTokenBalance(token, holder),
      (token, holder) => {
        assertToken(token);
        assertAddress(holder, "holder");
      },
    ),
  };
}
