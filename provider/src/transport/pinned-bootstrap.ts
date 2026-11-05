import type { WorkerPin } from "../config/mainnet.ts";

/** Function selectors of IWorkerSpecifier (anon-rpc SPEC §4). */
const SELECTOR_WORKER_HASH = "0x3898587d"; // workerHash()
const SELECTOR_WORKER_RESOLVERS = "0x1c67ff29"; // workerResolvers()

export interface Eip1193Like {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
}

/**
 * The harness needs a "pre-existing" RPC provider to read the worker specifier before the
 * anonymous transport exists (SPEC §5). A real RPC here would be one direct, trusted read.
 *
 * Instead, DeRPC answers the two specifier calls from the local pin and refuses everything
 * else, so booting the worker makes zero RPC requests. The pin is verified against chain state
 * later, through the worker (P2: prove storage slot 1 against a light-client state root).
 */
export function createPinnedBootstrapProvider(pin: WorkerPin): Eip1193Like {
  const specifier = pin.specifier.toLowerCase();
  return {
    async request({ method, params }) {
      const call = Array.isArray(params) ? (params[0] as { to?: string; data?: string } | undefined) : undefined;
      if (method === "eth_call" && call?.to?.toLowerCase() === specifier) {
        const selector = call.data?.slice(0, 10).toLowerCase();
        if (selector === SELECTOR_WORKER_HASH) return pin.workerHash;
        if (selector === SELECTOR_WORKER_RESOLVERS) return pin.resolversRaw;
      }
      throw new Error(`DeRPC pinned bootstrap: refusing ${method}; only the pinned specifier's workerHash() and workerResolvers() are answered`);
    },
  };
}
