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
  const workerHash = pin.workerHash;
  const resolversRaw = preferredBundleResolvers(pin);
  return {
    async request({ method, params }) {
      const call = Array.isArray(params) ? (params[0] as { to?: string; data?: string } | undefined) : undefined;
      if (method === "eth_call" && call?.to?.toLowerCase() === specifier) {
        const selector = call.data?.slice(0, 10).toLowerCase();
        if (selector === SELECTOR_WORKER_HASH) return workerHash;
        if (selector === SELECTOR_WORKER_RESOLVERS) return resolversRaw;
      }
      throw new Error(`DeRPC pinned bootstrap: refusing ${method}; only the pinned specifier's workerHash() and workerResolvers() are answered`);
    },
  };
}

/**
 * The gateway already sees the client's transport connection. Prefer its bundle mirror so a
 * working mirror avoids a separate CDN request. These are acquisition hints only: the harness
 * still checks every byte against workerHash, and public fallbacks fetch bundles, never RPC.
 *
 * Only pins advertising the exact hash-addressed KPS layout opt into gateway substitution.
 * Preserve other workers' raw resolver answers, including their custom resolver semantics.
 */
function preferredBundleResolvers(pin: WorkerPin): `0x${string}` {
  if (!/^0x[\da-fA-F]{64}$/.test(pin.workerHash)) return pin.resolversRaw;
  const hash = pin.workerHash.slice(2).toLowerCase();
  const path = `/keccak/${hash.slice(0, 2)}/${hash.slice(2)}`;
  const advertised = pin.resolvers.filter(resolver => {
    if (!resolver.startsWith("kps:")) return false;
    // SPEC §4.1: KPS resolver strings are not URLs; split at the first slash.
    const rest = resolver.slice(4), slash = rest.indexOf("/");
    return slash > 0 && rest.slice(slash) === path && validGateway(rest.slice(0, slash));
  });
  if (!advertised.length) return pin.resolversRaw;

  const gateways = pin.config.gateways;
  if (gateways !== undefined && (!Array.isArray(gateways) || gateways.some(gateway => typeof gateway !== "string" || !validGateway(gateway)))) {
    throw new Error("invalid bundle gateway address");
  }
  const preferred = Array.isArray(gateways) && gateways.length
    ? gateways.map(gateway => `kps:${gateway}${path}`)
    : advertised;
  return encodeStringArray([...new Set([...preferred, ...pin.resolvers])]);
}

function validGateway(address: string): boolean {
  const match = /^(?:\[[\da-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):([1-9]\d{0,4}):(u[A-Za-z0-9_-]{8,128})$/.exec(address);
  return !!match && Number(match[1]) <= 65535;
}

/** ABI return encoding for the single string[] value, including UTF-8 lengths and word padding. */
function encodeStringArray(values: readonly string[]): `0x${string}` {
  const word = (value: number) => value.toString(16).padStart(64, "0");
  const encoded = values.map(value => {
    const bytes = new TextEncoder().encode(value);
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return word(bytes.length) + hex.padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  });
  let offset = values.length * 32;
  const offsets = encoded.map(value => { const at = word(offset); offset += value.length / 2; return at; });
  return `0x${word(32)}${word(values.length)}${offsets.join("")}${encoded.join("")}`;
}
