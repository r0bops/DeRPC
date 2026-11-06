import { MAINNET_BEACON_ENDPOINTS, MAINNET_CHECKPOINT, TOR_JS_PIN, withGateways, type WorkerPin } from "../config/mainnet.ts";
import {
  startVerifiedHeaderSource,
  type HeaderSourceOptions,
  type VerifiedHeader,
  type VerifiedHeaderSource,
} from "../light-client/header-source.ts";
import { createPool, NoOperatorsChosenError, type EndpointStatus, type Pool, type PoolEndpoint, type PoolEvent } from "../pool/pool.ts";
import { createPooledReader } from "../pool/pooled-reader.ts";
import {
  startAnonTransport,
  TransportUnavailableError,
  type AnonTransport,
  type StartOptions,
  type TransportState,
  type WorkerLogLine,
} from "../transport/anon-transport.ts";
import { asFetch } from "../transport/fetch-adapter.ts";
import { createJsonRpcSend } from "../transport/json-rpc.ts";
import type { AccountProof } from "../verify/index.ts";
import type { JsonRpcSend, VerifiedReader } from "../verify/reader.ts";
import { checkWorkerPin, WorkerPinChainError, WorkerPinMismatchError } from "../verify/worker-pin.ts";
import { createEip1193Provider, ProviderRpcError, type Eip1193Provider } from "./eip1193.ts";

type Hex = `0x${string}`;

/** An operator the user chose. */
export type DeRPCOperator = PoolEndpoint & {
  /**
   * Testing and demos only: alters this operator's answers before verification, to show that DeRPC
   * rejects them. Never set it in production. See `simulatedLyingOperator`.
   */
  tamper?: (method: string, result: unknown) => unknown;
};

export interface DeRPCOptions {
  /** The operators the user chose. Without any, nothing is read until `setOperators`. */
  operators?: readonly DeRPCOperator[];
  /** tor-js gateway (KPS) addresses. Default: the pinned demo gateway. */
  gateways?: string[];
  /** The pinned anonymity worker. Default: tor-js 0.4.4. */
  worker?: WorkerPin;
  /** The light client's trusted checkpoint. Default: the one shipped with this build. */
  checkpoint?: { epoch: number; root: Hex };
  /** Beacon API for the light client (reached through the worker). */
  beaconUrl?: string;
  /** Timeout for one attempt on one operator. Default 20 s. */
  attemptTimeoutMs?: number;
  onStatus?: (status: DeRPCStatus) => void;
  onPoolEvent?: (event: PoolEvent) => void;
  onWorkerLog?: (line: WorkerLogLine) => void;
}

export interface DeRPCStatus {
  chainId: number;
  worker: { name: string; workerHash: Hex };
  checkpoint: { epoch: number; root: Hex };
  transport: { state: TransportState; error?: string };
  lightClient: { state: "waiting" | "syncing" | "verified" | "stale" | "failed"; header?: VerifiedHeader; error?: string };
  pin: { state: "waiting-for-operators" | "waiting-for-light-client" | "checking" | "verified" | "mismatch" | "failed"; workerHash?: Hex; block?: number; error?: string };
  operators: EndpointStatus[];
}

export interface DeRPC {
  /** EIP-1193 provider for proven reads (use with viem through `derpcTransport`). */
  readonly provider: Eip1193Provider;
  /** The same reads with their proof context (value plus the verified block), and ERC-20 balances. */
  readonly reader: VerifiedReader;
  /** Resolves when the worker runs and the light client has verified a fresh header. Rejects for good on failure. */
  readonly ready: Promise<void>;
  /** Replace the user's choice of operators. Exclusions from this session carry over. */
  setOperators(operators: readonly DeRPCOperator[]): void;
  status(): DeRPCStatus;
  /** Stop the worker. Every pending and later read fails as disconnected (4900); nothing goes direct. */
  close(): void;
}

export interface DeRPCDeps {
  startTransport(opts: StartOptions): AnonTransport;
  startHeaders(opts: HeaderSourceOptions): Promise<VerifiedHeaderSource>;
}

const CHAIN_ID = 1; // mainnet only, for now
const READ_METHODS = ["getBalance", "getTransactionCount", "getCode", "getStorageAt", "getTokenBalance"] as const;

/**
 * Private, verified Ethereum reads. Boots the pinned anonymity worker, syncs the light client through it,
 * proves the worker pin through the user's operators, then serves proven reads through them only.
 */
export function createDeRPC(options: DeRPCOptions = {}): DeRPC {
  return createDeRPCWith({ startTransport: startAnonTransport, startHeaders: startVerifiedHeaderSource }, options);
}

/** `createDeRPC` with the worker and light client injectable (tests). */
export function createDeRPCWith(deps: DeRPCDeps, options: DeRPCOptions = {}): DeRPC {
  const basePin = options.worker ?? TOR_JS_PIN;
  const pin = options.gateways?.length ? withGateways(basePin, options.gateways) : basePin;
  const checkpoint = options.checkpoint ?? MAINNET_CHECKPOINT;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 20_000;

  let transportError: string | undefined;
  let lightClient: { state: "waiting" | "syncing" | "verified" | "failed"; error?: string } = { state: "waiting" };
  let headerSource: VerifiedHeaderSource | undefined;
  let pool: Pool | undefined;
  const pooledReaders = new WeakMap<Pool, VerifiedReader>();
  const excluded = new Set<string>();
  let pinCheck: Promise<unknown> | undefined;
  let pinStatus: DeRPCStatus["pin"] = { state: "waiting-for-operators" };
  let disconnected = false;
  // Status goes out only once createDeRPC has returned: the transport reports "booting" while it starts.
  let live = false;
  const notify = () => {
    if (!live || !options.onStatus) return;
    try {
      options.onStatus(status());
    } catch (error) {
      // App callback failures must not take down DeRPC (#31).
      console.error("DeRPC onStatus callback failed", error);
    }
  };

  const { provider, emit } = createEip1193Provider({ chainId: CHAIN_ID, headers: () => headersReady, reader: readerForReads });

  function disconnect(reason: string) {
    if (disconnected) return;
    disconnected = true;
    emit("disconnect", new ProviderRpcError(4900, reason, { reason: "TransportUnavailableError" }));
  }

  const transport = deps.startTransport({
    pin,
    onLog: options.onWorkerLog,
    onState: (state, detail) => {
      if (detail) transportError = detail;
      if (state === "failed" || state === "closed") disconnect(`anonymous transport ${state}${detail ? `: ${detail}` : ""}`);
      notify();
    },
  });

  const headersReady: Promise<VerifiedHeaderSource> = (async () => {
    try {
      await transport.ready;
    } catch (error) {
      transportError = message(error);
      disconnect(`anonymous transport failed: ${transportError}`);
      notify();
      throw new TransportUnavailableError("failed", { cause: error });
    }
    lightClient = { state: "syncing" };
    notify();
    try {
      headerSource = await deps.startHeaders({
        network: "mainnet",
        checkpoint,
        beaconUrl: options.beaconUrl ?? MAINNET_BEACON_ENDPOINTS[0],
        fetch: asFetch(transport, { isolationKey: "derpc:consensus" }),
      });
    } catch (error) {
      lightClient = { state: "failed", error: message(error) };
      notify();
      throw error;
    }
    lightClient = { state: "verified" };
    emit("connect", { chainId: `0x${CHAIN_ID.toString(16)}` });
    startPinCheck();
    notify();
    return headerSource;
  })();
  headersReady.catch(() => {}); // reported through `ready`, status and every read

  function sendFor(endpoint: PoolEndpoint): JsonRpcSend {
    const send = createJsonRpcSend(transport, endpoint.url, { timeoutMs: attemptTimeoutMs });
    const tamper = (endpoint as DeRPCOperator).tamper;
    return tamper ? async (method, params, opts) => tamper(method, await send(method, params, opts)) : send;
  }

  function pooledReader(p: Pool, headers: VerifiedHeaderSource): VerifiedReader {
    let reader = pooledReaders.get(p);
    if (!reader) pooledReaders.set(p, (reader = createPooledReader({ headers, pool: p })));
    return reader;
  }

  /**
   * Prove the specifier's on-chain workerHash equals the pin the worker booted from, through the chosen
   * operators. A proven mismatch is final. A check that couldn't finish runs again with the next read.
   */
  function startPinCheck() {
    if (pinCheck) return;
    if (!headerSource || !pool) {
      pinStatus = { state: pool ? "waiting-for-light-client" : "waiting-for-operators" };
      return;
    }
    pinStatus = { state: "checking" };
    const check = checkWorkerPin({ pin, network: "mainnet", reader: pooledReader(pool, headerSource) });
    pinCheck = check;
    check.then(
      (r) => {
        pinStatus = { state: "verified", workerHash: r.workerHash, block: r.block.blockNumber };
        notify();
      },
      (error) => {
        const final = error instanceof WorkerPinMismatchError || error instanceof WorkerPinChainError;
        pinStatus = { state: final ? "mismatch" : "failed", error: message(error) };
        if (!final) pinCheck = undefined;
        notify();
      },
    );
    notify();
  }

  /** The reader for one request: only once everything before it holds, and never after the transport is gone. */
  async function readerForReads(): Promise<VerifiedReader> {
    const headers = await headersReady;
    const state = transport.state();
    if (state === "failed" || state === "closed") {
      throw new TransportUnavailableError(state);
    }
    if (!pool) throw new NoOperatorsChosenError();
    startPinCheck();
    const check = pinCheck!;
    check.catch(() => {});
    // Look up the pool again when the read actually sends: the choice may have changed while the
    // pin check ran, and removing every operator must refuse the read (#29).
    const gated: Record<string, unknown> = {};
    for (const name of READ_METHODS) {
      gated[name] = async (...args: unknown[]) => {
        await check;
        if (disconnected) throw new TransportUnavailableError("closed");
        if (!pool) throw new NoOperatorsChosenError();
        return (pooledReader(pool, headers)[name] as (...a: unknown[]) => Promise<unknown>)(...args);
      };
    }
    return gated as unknown as VerifiedReader;
  }

  function setOperators(operators: readonly DeRPCOperator[]) {
    pool = operators.length
      ? createPool({
          endpoints: operators.map((o) => ({ ...o })),
          sendFor,
          excluded,
          onEvent: (event) => {
            if (event.type === "invalid-proof" && event.endpoint) excluded.add(event.endpoint);
            if (options.onPoolEvent) {
              try {
                options.onPoolEvent(event);
              } catch (error) {
                // App callback failures must not turn a verified answer into an operator failure (#31).
                console.error("DeRPC onPoolEvent callback failed", error);
              }
            }
            notify();
          },
        })
      : undefined;
    if (!pinCheck) pinStatus = { state: pool ? "waiting-for-light-client" : "waiting-for-operators" };
    if (headerSource) startPinCheck();
    notify();
  }

  function status(): DeRPCStatus {
    let lc: DeRPCStatus["lightClient"] = lightClient;
    if (lightClient.state === "verified" && headerSource) {
      try {
        lc = { state: "verified", header: headerSource.finalized() };
      } catch (error) {
        lc = { state: "stale", error: message(error) };
      }
    }
    return {
      chainId: CHAIN_ID,
      worker: { name: pin.name, workerHash: pin.workerHash },
      checkpoint,
      transport: { state: transport.state(), ...(transportError ? { error: transportError } : {}) },
      lightClient: lc,
      pin: pinStatus,
      operators: pool?.status() ?? [],
    };
  }

  const reader = {} as Record<keyof VerifiedReader, (...args: never[]) => Promise<unknown>>;
  for (const name of READ_METHODS) {
    reader[name] = async (...args: never[]) => ((await readerForReads())[name] as (...a: never[]) => Promise<unknown>)(...args);
  }

  if (options.operators?.length) setOperators(options.operators);
  live = true;
  queueMicrotask(notify);

  return {
    provider,
    reader: reader as unknown as VerifiedReader,
    ready: headersReady.then(() => undefined),
    setOperators,
    status,
    close() {
      transport.close();
      headerSource?.close();
      disconnect("closed by the app");
      notify();
    },
  };
}

/**
 * Demo and testing only: an operator that sends the real request to `base` through the worker, then
 * inflates the balances it returns (+1000 ETH, or +1000 units of a token). DeRPC must reject it. It is
 * preferred over the user's operators so that the demo hits it first. Rejecting it is local evidence only.
 */
export function simulatedLyingOperator(base: DeRPCOperator): DeRPCOperator {
  return {
    id: `simulated-liar:${base.id ?? base.url}`,
    url: base.url,
    priority: -1,
    operator: "simulated lying operator (demo)",
    tamper: (method, result) => {
      if (method !== "eth_getProof" || !result || typeof result !== "object") return result;
      const proof = structuredClone(result) as AccountProof;
      const inflate = (hex: string) => `0x${(BigInt(hex) + 10n ** 21n).toString(16)}` as Hex;
      proof.balance = inflate(proof.balance);
      proof.storageProof = proof.storageProof.map((entry) => ({ ...entry, value: inflate(entry.value) }));
      return proof;
    },
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
