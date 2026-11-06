import type { VerifiedHeader } from "../light-client/header-source.ts";
import { TransportUnavailableError } from "../transport/anon-transport.ts";
import type { VerifiedReader, VerifiedValue } from "../verify/reader.ts";

type Hex = `0x${string}`;

/** EIP-1193 error: branch on `code`, and on `data.reason` (the DeRPC error name) for detail. */
export class ProviderRpcError extends Error {
  override name = "ProviderRpcError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: { reason: string },
  ) {
    super(message);
  }
}

export interface RequestArguments {
  readonly method: string;
  readonly params?: readonly unknown[] | object;
}

export type ProviderEvent = "connect" | "disconnect" | "chainChanged" | "accountsChanged" | "message";

export interface Eip1193Provider {
  request(args: RequestArguments): Promise<unknown>;
  on(event: ProviderEvent, listener: (...args: any[]) => void): Eip1193Provider;
  removeListener(event: ProviderEvent, listener: (...args: any[]) => void): Eip1193Provider;
}

/** What the request interface reads from. The DeRPC wiring provides it; tests provide fixtures. */
export interface ReadBackend {
  chainId: number;
  /** Capture authorization at request entry, before asynchronous header startup can change it. */
  requestSignal?(): AbortSignal;
  /** Resolves once verified headers exist (waits for initialization); rejects if they never will. */
  headers(): Promise<{ finalized(): VerifiedHeader }>;
  /** Resolves with the gated, pooled verified reader; rejects when reads can't happen (no operators, failed transport…). */
  reader(): Promise<VerifiedReader>;
  /** Present only for an explicit local-execution opt-in; never sends remote eth_call. */
  verifiedCall?(input: { to: Hex; data?: Hex; from?: Hex; gas?: bigint }): Promise<VerifiedValue<Hex>>;
}

/** Methods DeRPC answers. Every value read from the chain is proven at the verified finalized block. */
export const SUPPORTED_METHODS = [
  "eth_chainId",
  "net_version",
  "eth_accounts",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getCode",
  "eth_getStorageAt",
] as const;

// Errors where DeRPC refuses to answer to stay safe; reported as "resource unavailable" with the reason.
const REFUSALS = new Set([
  "NoOperatorsChosenError",
  "PoolExhaustedError",
  "HeaderSourceNotReadyError",
  "StaleHeaderError",
  "StaleCheckpointError",
  "WorkerPinMismatchError",
  "WorkerPinChainError",
  "ProofVerificationError",
]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * An EIP-1193 provider for proven reads. Anything it can't prove is refused before anything is sent:
 * there is no pass-through to an operator, and no direct connection.
 */
export function createEip1193Provider(backend: ReadBackend): {
  provider: Eip1193Provider;
  emit(event: ProviderEvent, ...args: unknown[]): void;
} {
  const listeners = new Map<ProviderEvent, Set<(...args: any[]) => void>>();

  async function dispatch(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    switch (method) {
      case "eth_chainId":
        return `0x${backend.chainId.toString(16)}`;
      case "net_version":
        return String(backend.chainId);
      case "eth_accounts":
        return []; // the read provider never exposes host-side payment signing keys
      case "eth_blockNumber": {
        const headers = await backend.headers();
        return `0x${headers.finalized().blockNumber.toString(16)}`;
      }
      case "eth_getBalance":
      case "eth_getTransactionCount":
      case "eth_getCode": {
        const address = addressParam(params[0]);
        const read = await prepare(params[1], signal);
        if (method === "eth_getCode") return read((r) => r.getCode(address));
        const value = await read((r) => (method === "eth_getBalance" ? r.getBalance(address) : r.getTransactionCount(address)));
        return `0x${value.toString(16)}`;
      }
      case "eth_getStorageAt": {
        const address = addressParam(params[0]);
        const slot = slotParam(params[1]);
        const read = await prepare(params[2], signal);
        const value = await read((r) => r.getStorageAt(address, slot));
        return `0x${value.toString(16).padStart(64, "0")}`;
      }
      case "eth_call": {
        if (!backend.verifiedCall) throw new ProviderRpcError(4200, "eth_call results carry no proof: enable local verified execution explicitly before using this method");
        if (params.length > 2 || !params[0] || typeof params[0] !== "object" || Array.isArray(params[0])) throw new ProviderRpcError(-32602, "expected a call object and finalized block selector, with no state overrides");
        const input = params[0] as Record<string, unknown>;
        if (Object.keys(input).some(key => !["to", "from", "data", "input", "gas"].includes(key))) throw new ProviderRpcError(-32602, "verified calls accept only to, from, data/input and gas");
        if (input.data !== undefined && input.input !== undefined && input.data !== input.input) throw new ProviderRpcError(-32602, "data and input disagree");
        const data = input.data ?? input.input ?? "0x";
        if (typeof data !== "string" || !/^0x(?:[\da-fA-F]{2})*$/.test(data)) throw new ProviderRpcError(-32602, "expected hex call data");
        if (input.gas !== undefined && (typeof input.gas !== "string" || !QUANTITY.test(input.gas))) throw new ProviderRpcError(-32602, "expected hex gas quantity");
        const to = addressParam(input.to);
        const from = input.from === undefined ? undefined : addressParam(input.from);
        const want = blockSelector(params[1]);
        const headers = await backend.headers();
        signal?.throwIfAborted();
        if (want) checkBlock(want, headers.finalized());
        const result = await backend.verifiedCall({ to, from, data: data as Hex, gas: input.gas === undefined ? undefined : BigInt(input.gas as string) });
        signal?.throwIfAborted();
        if (want) checkBlock(want, result.block);
        return result.value;
      }
      default:
        throw new ProviderRpcError(
          4200,
          method === "eth_call"
            ? "eth_call results carry no proof: DeRPC refuses them rather than return an unverified answer"
            : `DeRPC only serves reads it can prove (${SUPPORTED_METHODS.join(", ")}); ${method} is refused, not forwarded`,
        );
    }
  }

  /** Check the block parameter against the verified block, then return a reader bound to it. */
  async function prepare(blockParam: unknown, signal?: AbortSignal) {
    const headers = await backend.headers();
    signal?.throwIfAborted();
    const want = blockSelector(blockParam);
    const current = headers.finalized();
    if (want) checkBlock(want, current);
    const reader = await backend.reader();
    signal?.throwIfAborted();
    return async <T>(fn: (r: VerifiedReader) => Promise<VerifiedValue<T>>): Promise<T> => {
      signal?.throwIfAborted();
      const result = await fn(reader);
      signal?.throwIfAborted();
      if (want) checkBlock(want, result.block); // the verified block may have moved on meanwhile
      return result.value;
    };
  }

  const provider: Eip1193Provider = {
    async request(args) {
      const params = Array.isArray(args.params) ? args.params : [];
      try {
        const needsOperator = ["eth_getBalance", "eth_getTransactionCount", "eth_getCode", "eth_getStorageAt", "eth_call"].includes(args.method);
        const signal = needsOperator ? backend.requestSignal?.() : undefined;
        const result = dispatch(args.method, params, signal);
        return await (signal ? withinSignal(result, signal) : result);
      } catch (error) {
        throw toProviderError(error);
      }
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return provider;
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
      return provider;
    },
  };

  return {
    provider,
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) {
        try {
          listener(...args);
        } catch {
          // A listener's failure is its own; it must not break the provider.
        }
      }
    },
  };
}

/** Stop waiting promptly; dispatch also checks before starting any work after a cancelled await. */
function withinSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { work.catch(() => {}); reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

type BlockSelector = { number: number } | { hash: string } | undefined;

/** `undefined` means "the verified finalized block". Anything DeRPC can't prove is refused. */
function blockSelector(param: unknown): BlockSelector {
  if (param === undefined || param === "finalized") return undefined;
  if (typeof param === "string" && QUANTITY.test(param)) return { number: Number.parseInt(param, 16) };
  if (param && typeof param === "object") {
    const p = param as { blockHash?: unknown; blockNumber?: unknown };
    if (typeof p.blockHash === "string" && HASH.test(p.blockHash)) return { hash: p.blockHash.toLowerCase() };
    if (typeof p.blockNumber === "string" && QUANTITY.test(p.blockNumber)) return { number: Number.parseInt(p.blockNumber, 16) };
  }
  throw new ProviderRpcError(
    -32602,
    `DeRPC proves state only at the verified finalized block: pass "finalized" (or that block's number or hash), not ${JSON.stringify(param)}`,
  );
}

function checkBlock(want: NonNullable<BlockSelector>, block: VerifiedHeader) {
  const ok = "number" in want ? want.number === block.blockNumber : want.hash === block.blockHash.toLowerCase();
  if (!ok) {
    throw new ProviderRpcError(
      -32602,
      `DeRPC proves state only at the verified finalized block (${block.blockNumber}); the requested block isn't it. Pass "finalized"`,
    );
  }
}

function addressParam(value: unknown): Hex {
  if (typeof value === "string" && ADDRESS.test(value)) return value as Hex;
  throw new ProviderRpcError(-32602, `expected a 20-byte hex address, got ${JSON.stringify(value)}`);
}

/** Storage slots go out as 32-byte words, the form every node accepts. */
function slotParam(value: unknown): Hex {
  if (typeof value === "string" && QUANTITY.test(value)) return `0x${value.slice(2).padStart(64, "0")}` as Hex;
  throw new ProviderRpcError(-32602, `expected a storage slot (hex, up to 32 bytes), got ${JSON.stringify(value)}`);
}

function toProviderError(error: unknown): ProviderRpcError {
  if (error instanceof ProviderRpcError) return error;
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TransportUnavailableError) return new ProviderRpcError(4900, message, { reason: name });
  if (name === "InputError") return new ProviderRpcError(-32602, message, { reason: name });
  if (["ExecutionLimitError", "UnsupportedExecutionError", "CallRevertedError"].includes(name)) return new ProviderRpcError(-32002, message, { reason: name });
  if (REFUSALS.has(name)) return new ProviderRpcError(-32002, message, { reason: name });
  return new ProviderRpcError(-32603, message, { reason: name });
}
