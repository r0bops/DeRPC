import { MAINNET_BEACON_ENDPOINTS, MAINNET_CHECKPOINT, TOR_JS_PIN, withGateways, type WorkerPin } from "../config/mainnet.ts";
import {
  startVerifiedHeaderSource,
  type HeaderSourceOptions,
  type VerifiedHeader,
  type PollHealth,
  type VerifiedHeaderSource,
} from "../light-client/header-source.ts";
import { assertOperatorActive, createPool, NoOperatorsChosenError, type EndpointStatus, type Pool, type PoolEndpoint, type PoolEvent, type PoolOperationContext, type PoolAttemptLifecycle } from "../pool/pool.ts";
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
import type { HeaderView, JsonRpcSend, VerifiedReader, VerifiedValue } from "../verify/reader.ts";
import { checkWorkerPin, gateReader, WorkerPinChainError, WorkerPinMismatchError } from "../verify/worker-pin.ts";
import { createEip1193Provider, ProviderRpcError, type Eip1193Provider } from "./eip1193.ts";
import { assertSeparateGateway, checkOperatorIdentity, operatorUrl } from "../operators/endpoint.ts";
import { readResponseBody } from "../transport/response-body.ts";
import type { Directory, PaymentTerms } from "../discovery/ens.ts";
import type { RegistrarPin } from "../discovery/registrar.ts";
import type { ExecutionLimits } from "../execution/index.ts";

type Hex = `0x${string}`;

/** An operator the user chose. */
export type DeRPCOperator = PoolEndpoint & {
  beaconUrl?: string;
  /** Gateways this operator also runs; pairing is refused. */
  gateways?: string[];
  /** Require the endpoint's identity to match these ENS records before sending reads. */
  wrapperIdentity?: { signer: Hex };
  /** Memory-only credential for an unpublished own-node endpoint. Never include in a registry. */
  personalToken?: string;
  /** Discovered terms. A funded client session is required before user reads. */
  payment?: PaymentTerms;
  /** Demo-only alias so simulated corruption uses its base operator's funded session. */
  paymentOperatorId?: string;
  /**
   * Testing and demos only: alters this operator's answers before verification, to show that DeRPC
   * rejects them. Never set it in production. See `simulatedLyingOperator`.
   */
  tamper?: (method: string, result: unknown) => unknown;
};

export interface DeRPCOptions {
  /** The operators the user chose. Without any, nothing is read until `setOperators`. */
  operators?: DeRPCOperator[];
  /** tor-js gateway (KPS) addresses. Default: the pinned demo gateway. */
  gateways?: string[];
  /** The pinned anonymity worker. Default: tor-js 0.4.4. */
  worker?: WorkerPin;
  /** The light client's trusted checkpoint. Default: the one shipped with this build. */
  checkpoint?: { epoch: number; root: Hex };
  /** Beacon API for the light client (reached through the worker). */
  beaconUrl?: string;
  beaconUrls?: string[];
  /** Independently known gateway ownership, keyed by KPS gateway address. */
  gatewayOwners?: Record<string, string>;
  /** Timeout for one attempt on one operator. Default 20 s. */
  attemptTimeoutMs?: number;
  /** Mutable session manager from @derpc/payments; keys stay in the host. */
  payments?: DeRPCPaymentClient;
  /** true enables only the explicit verifiedCall API. EIP-1193 eth_call needs eip1193:true. */
  verifiedCalls?: true | { eip1193?: boolean; limits?: Partial<ExecutionLimits> };
  onStatus?: (status: DeRPCStatus) => void;
  onPoolEvent?: (event: PoolEvent) => void;
  onWorkerLog?: (line: WorkerLogLine) => void;
}

/** Structural interface keeps free readers independent of the optional signing package. */
export interface DeRPCPaymentClient {
  has(operatorId: string): boolean;
  begin(operatorId: string, kind: "proof" | "code" | "call", options?: { signal?: AbortSignal }): Promise<{
    headers(): Record<string, string>;
    verified(signal?: AbortSignal): Promise<unknown>;
    failed(): void;
  }>;
  latestVoucher(operatorId: string): { sessionId: bigint; amount: bigint; signature: Hex } | undefined;
  prepareClose(operatorId: string): Promise<{ voucher: { sessionId: bigint; amount: bigint; signature: Hex }; closeAuthorization: Hex; closeDeadline: number }>;
  /** Used to distinguish a new funded session from the previous session for the same operator. */
  snapshot?(): { operatorId: string; sessionId: bigint; chainId: number; escrow: Hex }[];
}

export interface VerifiedCallInput { to: Hex; data?: Hex; from?: Hex; gas?: bigint; signal?: AbortSignal }
export interface RefreshDirectoryOptions {
  ethRegistry: Hex;
  registrar?: RegistrarPin;
  verifiedRecords?: boolean;
  signal?: AbortSignal;
  totalTimeoutMs?: number;
}
export interface PaymentSettlement {
  highestAmount: string;
  settlement?: { state: string; transactionHash?: Hex; paid?: string; refunded?: string };
}

export interface DeRPCStatus {
  chainId: number;
  worker: { name: string; workerHash: Hex };
  checkpoint: { epoch: number; root: Hex };
  transport: { state: TransportState; error?: string };
  lightClient: { state: "waiting" | "syncing" | "verified" | "stale" | "failed"; header?: VerifiedHeader; error?: string; poll?: PollHealth };
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
  /** Replace the user's choice; expired listings are refused and session exclusions carry over. */
  setOperators(operators: DeRPCOperator[]): void;
  /** Read the complete ENS list, then retain only the user's still-valid selected ENS entries. */
  refreshDirectory(options: RefreshDirectoryOptions): Promise<Directory>;
  /** Locally execute against proven state; disabled unless verifiedCalls was explicitly enabled. */
  verifiedCall(input: VerifiedCallInput): Promise<VerifiedValue<Hex>>;
  /** Retain a confirmed session's endpoint for settlement without selecting it for reads. */
  registerPaymentOperator(operator: DeRPCOperator): void;
  /** Deliver the last voucher and optionally authorize one closing transaction, through the worker. */
  settlePayment(operatorId: string, options?: { close?: boolean; signal?: AbortSignal }): Promise<PaymentSettlement>;
  status(): DeRPCStatus;
  /** Stop the worker. Every pending and later read fails as disconnected (4900); nothing goes direct. */
  close(): void;
}

export interface DeRPCDeps {
  startTransport(opts: StartOptions): AnonTransport;
  startHeaders(opts: HeaderSourceOptions): Promise<VerifiedHeaderSource>;
}

const CHAIN_ID = 1; // mainnet only, for now

/**
 * Private, verified Ethereum reads. Boots the pinned anonymity worker, syncs the light client through it,
 * proves the worker pin through the user's operators, then serves proven reads through them only.
 */
export function createDeRPC(options: DeRPCOptions = {}): DeRPC {
  return createDeRPCWith({ startTransport: startAnonTransport, startHeaders: startVerifiedHeaderSource }, options);
}

/** `createDeRPC` with the worker and light client injectable (tests). */
export function createDeRPCWith(deps: DeRPCDeps, options: DeRPCOptions = {}): DeRPC {
  // Initial operator credentials must not survive through the long-lived options closure.
  let initialOperators = options.operators ?? [];
  options = { ...options, operators: undefined };
  const basePin = options.worker ?? TOR_JS_PIN;
  const pin = options.gateways?.length ? withGateways(basePin, options.gateways) : basePin;
  const checkpoint = options.checkpoint ?? MAINNET_CHECKPOINT;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 20_000;
  const callTimeoutMs = typeof options.verifiedCalls === "object" ? options.verifiedCalls.limits?.timeoutMs ?? 60_000 : 60_000;
  const lifetime = new AbortController();
  let selection = new AbortController();
  let chosenOperators: DeRPCOperator[] = [];
  const knownOperators = new Map<string, DeRPCOperator>();
  const paymentEndpoints = new Map<string, { operator: DeRPCOperator; session?: string }>();
  const checkedIdentities = new Map<string, Promise<void>>();
  const gateways = (pin.config as { gateways?: string[] }).gateways ?? [];
  function paymentSession(id: string): string | undefined {
    const active = options.payments?.snapshot?.().find(session => session.operatorId === id);
    return active ? `${active.chainId}:${active.escrow.toLowerCase()}:${active.sessionId}` : undefined;
  }
  function pinPaymentEndpoint(id: string, operator: DeRPCOperator): void {
    const session = paymentSession(id);
    const prior = paymentEndpoints.get(id);
    if (!prior || prior.session !== session) paymentEndpoints.set(id, { operator, session });
  }
  function validateOperators(operators: DeRPCOperator[], forSettlement = false) {
    for (const operator of operators) {
      // An expired listing can still receive the final voucher for an existing funded session.
      assertOperatorActive(operator, forSettlement ? 0 : Date.now());
      const endpoint = operatorUrl(operator.url);
      assertSeparateGateway(operator, gateways, options.gatewayOwners);
      if (operator.beaconUrl) operatorUrl(operator.beaconUrl);
      if (operator.wrapperIdentity && (!operator.ens || !/^0x[\da-fA-F]{40}$/.test(operator.wrapperIdentity.signer))) throw new Error("wrapper requires an ENS name and signer");
      if (operator.personalToken !== undefined) {
        if (!endpoint.hostname.endsWith(".onion") || !/^[a-f0-9]{64}$/.test(operator.personalToken) || operator.ens || operator.wrapperIdentity) throw new Error("personal mode requires an unpublished onion and a 32-byte token");
        if (operator.beaconUrl && new URL(operator.beaconUrl).origin !== endpoint.origin) throw new Error("personal beacon must share the private onion");
        if (operator.payment) throw new Error("personal nodes do not take payments");
      }
    }
  }
  validateOperators(initialOperators); // reject unsafe pairing before booting a worker
  const operatorBeacons = initialOperators.flatMap(o => o.beaconUrl ? [o.beaconUrl] : []);
  const beaconUrls = [...new Set([...(options.beaconUrl ? [options.beaconUrl] : []), ...(options.beaconUrls ?? []), ...operatorBeacons])];
  if (!beaconUrls.length) beaconUrls.push(...MAINNET_BEACON_ENDPOINTS);
  for (const beacon of beaconUrls) operatorUrl(beacon);
  const personalHeaders = new Map<string, Record<string, string>>();
  const consensusFetch = (transport: AnonTransport, attempt: number) => asFetch(transport, {
    isolationKey: `derpc:consensus:${attempt}`,
    headersForUrl: url => personalHeaders.get(new URL(url).origin) ?? {},
  });

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
    if (live) { try { options.onStatus?.(status()); } catch { /* app observer */ } }
  };

  const { provider, emit } = createEip1193Provider({
    chainId: CHAIN_ID, headers: readyHeaders, reader: readerForReads,
    verifiedCall: typeof options.verifiedCalls === "object" && options.verifiedCalls.eip1193 ? verifiedCall : undefined,
  });

  function disconnect(reason: string, state: "closed" | "failed" = "closed") {
    if (disconnected) return;
    disconnected = true;
    lifetime.abort(new TransportUnavailableError(state));
    emit("disconnect", new ProviderRpcError(4900, reason, { reason: "TransportUnavailableError" }));
  }

  const transport = deps.startTransport({
    pin,
    onLog: line => { try { options.onWorkerLog?.(line); } catch { /* app observer */ } },
    onState: (state, detail) => {
      if (detail) transportError = detail;
      if (state === "failed" || state === "closed") disconnect(`anonymous transport ${state}${detail ? `: ${detail}` : ""}`, state);
      notify();
    },
  });

  const headersReady: Promise<VerifiedHeaderSource> = (async () => {
    try {
      await abortable(transport.ready, lifetime.signal);
    } catch (error) {
      // App shutdown is final; cancellation of startup must not turn it into a worker failure.
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      transportError = message(error);
      disconnect(`anonymous transport failed: ${transportError}`, "failed");
      notify();
      throw new TransportUnavailableError("failed", { cause: error });
    }
    lightClient = { state: "syncing" };
    notify();
    try {
      const starting = deps.startHeaders({
        network: "mainnet",
        checkpoint,
        beaconUrl: beaconUrls[0]!,
        beaconUrls: beaconUrls.slice(1),
        fetch: consensusFetch(transport, 1),
        fetchForAttempt: attempt => consensusFetch(transport, attempt),
        signal: lifetime.signal,
      });
      starting.then(headers => { if (lifetime.signal.aborted) headers.close(); }, () => {});
      headerSource = await abortable(starting, lifetime.signal);
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
    const operator = endpoint as DeRPCOperator;
    const rawSend = createJsonRpcSend(transport, endpoint.url, {
      timeoutMs: attemptTimeoutMs,
      headers: operator.personalToken ? { authorization: `Bearer ${operator.personalToken}` } : undefined,
    });
    return async (method, params, opts) => {
      assertOperatorActive(operator);
      if (operator.wrapperIdentity) {
        const key = `${operator.url}|${operator.ens}|${operator.wrapperIdentity.signer}`;
        let check = checkedIdentities.get(key);
        if (!check) {
          check = checkOperatorIdentity(transport, endpoint.url, { ens: operator.ens!, signer: operator.wrapperIdentity.signer }, lifetime.signal).then(() => undefined);
          checkedIdentities.set(key, check);
          check.catch(() => { if (checkedIdentities.get(key) === check) checkedIdentities.delete(key); });
        }
        await abortable(check, opts.signal ?? lifetime.signal);
      }
      // Identity lookup may have crossed the listing deadline while this request was waiting.
      assertOperatorActive(operator);
      const result = await rawSend(method, params, opts);
      return operator.tamper ? operator.tamper(method, result) : result;
    };
  }

  async function prepareAttempt(context: PoolOperationContext, send: JsonRpcSend): Promise<PoolAttemptLifecycle> {
    const operator = context.endpoint as DeRPCOperator;
    const id = operator.paymentOperatorId ?? operator.id ?? operator.url;
    if (!context.paid || operator.personalToken) return { send };
    if (!options.payments?.has(id)) {
      if (operator.payment) throw new Error(`open a funded test-payment session for ${operator.ens ?? id} before reading`);
      return { send };
    }
    pinPaymentEndpoint(id, operator);
    const payment = await options.payments.begin(id, context.kind, { signal: context.signal });
    return {
      send: (method, params, opts) => send(method, params, { ...opts, headers: { ...opts.headers, ...payment.headers() } }),
      verified: () => payment.verified(context.signal),
      failed: () => payment.failed(),
    };
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
    const check = checkWorkerPin({ pin, network: "mainnet", reader: createPooledReader({ pool, headers: headerSource, paid: false }) });
    pinCheck = check;
    check.then(
      (r) => {
        if (pinCheck !== check) return;
        pinStatus = { state: "verified", workerHash: r.workerHash, block: r.block.blockNumber };
        notify();
      },
      (error) => {
        if (pinCheck !== check) return;
        const final = error instanceof WorkerPinMismatchError || error instanceof WorkerPinChainError;
        pinStatus = { state: final ? "mismatch" : "failed", error: message(error) };
        if (!final) pinCheck = undefined;
        notify();
      },
    );
    notify();
  }

  async function readyHeaders(): Promise<VerifiedHeaderSource> {
    lifetime.signal.throwIfAborted();
    const headers = await abortable(headersReady, lifetime.signal);
    lifetime.signal.throwIfAborted();
    return headers;
  }

  async function readContext(callerSignal?: AbortSignal): Promise<{ headers: VerifiedHeaderSource; currentPool: Pool; block: VerifiedHeader }> {
    callerSignal?.throwIfAborted();
    const headers = callerSignal ? await abortable(readyHeaders(), callerSignal) : await readyHeaders();
    if (!pool) throw new NoOperatorsChosenError();
    const currentPool = pool;
    const currentSelection = selection;
    startPinCheck();
    await abortable(pinCheck!, AbortSignal.any([lifetime.signal, currentSelection.signal, ...(callerSignal ? [callerSignal] : [])]));
    currentSelection.signal.throwIfAborted();
    return { headers, currentPool, block: headers.finalized() };
  }

  async function verifiedCall(input: VerifiedCallInput): Promise<VerifiedValue<Hex>> {
    if (!options.verifiedCalls) throw new ProviderRpcError(4200, "enable verifiedCalls to execute a call locally against proven state");
    const { createVerifiedExecutor, assertVerifiedCallInput } = await import("../execution/index.ts");
    assertVerifiedCallInput(input);
    const { headers, currentPool, block } = await readContext(input.signal);
    const pinned: HeaderView = { finalized: () => block, assertFresh: header => headers.assertFresh(header) };
    const result = await currentPool.run(async (send, context) => {
      const executor = createVerifiedExecutor({ headers: pinned, send, limits: typeof options.verifiedCalls === "object" ? options.verifiedCalls.limits : undefined });
      const result = await executor.call({ ...input, signal: context.signal });
      headers.assertFresh(result.block);
      return result;
    }, { account: input.from ?? input.to, kind: "call", signal: input.signal, totalTimeoutMs: callTimeoutMs, assertValid: () => headers.assertFresh(block) });
    headers.assertFresh(result.block);
    return result;
  }

  async function refreshDirectory(request: RefreshDirectoryOptions): Promise<Directory> {
    if (request.verifiedRecords && !options.verifiedCalls) throw new ProviderRpcError(4200, "enable verifiedCalls before requesting proven ENS records");
    const { headers, currentPool, block } = await readContext(request.signal);
    const originalSelection = selection;
    const pinned: HeaderView = { finalized: () => block, assertFresh: header => headers.assertFresh(header) };
    const { discoverOperators, retainChosenOperators, readProvenOperators } = await import("../discovery/ens.ts");
    const { createVerifiedExecutor } = request.verifiedRecords ? await import("../execution/index.ts") : { createVerifiedExecutor: undefined };
    const totalTimeoutMs = request.totalTimeoutMs ?? 120_000;
    const signal = AbortSignal.any([lifetime.signal, originalSelection.signal, ...(request.signal ? [request.signal] : [])]);
    const directory = await discoverOperators({
      transport, executionUrl: chosenOperators[0]!.url, headers: pinned, ethRegistry: request.ethRegistry,
      registrar: request.registrar, signal, totalTimeoutMs,
      // Raw ENS calls remain internal and unverified. A paid wrapper may refuse these;
      // verifiedRecords uses the local executor below and never sends eth_call upstream.
      send: (method, params, opts) => currentPool.run(send => send(method, params, opts), { paid: false, signal: opts.signal ?? signal }),
      // Each completed local call is one logical read, keeping payment authorizations bounded
      // independently of directory size. Verification/freshness finish before the pool signs.
      verifiedCall: createVerifiedExecutor ? (to, data, opts) => currentPool.run(async (send, context) => {
        const executor = createVerifiedExecutor({ headers: pinned, send, limits: typeof options.verifiedCalls === "object" ? options.verifiedCalls.limits : undefined });
        const result = await executor.call({ to, data, signal: context.signal });
        headers.assertFresh(result.block);
        return result;
      }, { kind: "call", account: "derpc:operator-discovery", signal: opts?.signal ?? signal, totalTimeoutMs: callTimeoutMs, assertValid: () => headers.assertFresh(block) }) : undefined,
      readRegistrar: (registrar, opts) => currentPool.run(async (send, context) => {
        const result = await readProvenOperators({ headers: pinned, send, registrar, signal: context.signal });
        headers.assertFresh(result.block);
        return result;
      }, { kind: "call", account: "derpc:operator-discovery", signal: opts?.signal ?? signal, totalTimeoutMs, assertValid: () => headers.assertFresh(block) }),
    });
    originalSelection.signal.throwIfAborted();
    const retained = retainChosenOperators(directory, chosenOperators.flatMap(o => o.ens ? [o.ens] : []));
    // Personal endpoints are never published into ENS and are not removed by a public registry.
    setOperators([...chosenOperators.filter(o => !!o.personalToken), ...retained]);
    return directory;
  }

  async function settlePayment(operatorId: string, request: { close?: boolean; signal?: AbortSignal } = {}): Promise<PaymentSettlement> {
    lifetime.signal.throwIfAborted();
    if (!options.payments?.has(operatorId)) throw new Error("no funded payment session for this operator");
    const retained = paymentEndpoints.get(operatorId);
    const operator = retained && retained.session === paymentSession(operatorId) ? retained.operator : knownOperators.get(operatorId);
    if (!operator || operator.personalToken) throw new Error("no known paid endpoint for this session");
    const signal = request.signal ? AbortSignal.any([request.signal, lifetime.signal]) : lifetime.signal;
    await abortable(transport.ready, signal);
    const closing = request.close ? await abortable(options.payments.prepareClose(operatorId), signal) : undefined;
    const voucher = closing?.voucher ?? options.payments.latestVoucher(operatorId);
    if (!voucher) return { highestAmount: "0", settlement: { state: "open" } };
    const body = {
      sessionId: voucher.sessionId.toString(), amount: voucher.amount.toString(), signature: voucher.signature,
      ...(closing ? { close: true, closeAuthorization: closing.closeAuthorization, closeDeadline: closing.closeDeadline } : {}),
    };
    const timeoutMs = 30_000;
    const deadline = performance.now() + timeoutMs;
    signal.throwIfAborted();
    const response = await transport.fetch(new URL("/payments/voucher", operator.url).href, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      isolationKey: `derpc:payment:${operatorId}`, timeoutMs, signal, redirect: "error",
    });
    const bytes = await readResponseBody(response, { maxBytes: 16 * 1024, timeoutMs: deadline - performance.now(), signal });
    if (!response.ok) throw new Error(`operator refused payment settlement (HTTP ${response.status})`);
    const result = JSON.parse(new TextDecoder().decode(bytes)) as PaymentSettlement;
    if (!result || typeof result.highestAmount !== "string" || !/^(0|[1-9]\d{0,77})$/.test(result.highestAmount) || BigInt(result.highestAmount) > voucher.amount) throw new Error("invalid payment settlement acknowledgment");
    return result;
  }

  function registerPaymentOperator(operator: DeRPCOperator): void {
    lifetime.signal.throwIfAborted();
    validateOperators([operator], true);
    const id = operator.paymentOperatorId ?? operator.id ?? operator.url;
    if (operator.personalToken || !options.payments?.has(id)) throw new Error("a confirmed funded payment session is required");
    const prior = paymentEndpoints.get(id);
    if (prior && prior.session === paymentSession(id) && prior.operator.url !== operator.url) throw new Error("the funded session's settlement endpoint is already pinned");
    const copy = { ...operator, gateways: operator.gateways ? [...operator.gateways] : undefined, wrapperIdentity: operator.wrapperIdentity ? { ...operator.wrapperIdentity } : undefined, payment: operator.payment ? { ...operator.payment } : undefined };
    pinPaymentEndpoint(id, copy);
    knownOperators.set(id, copy);
  }

  /** The reader for one request: only once everything before it holds, and never after the transport is gone. */
  async function readerForReads(): Promise<VerifiedReader> {
    const headers = await readyHeaders();
    const state = transport.state();
    if (state === "failed" || state === "closed") {
      throw new TransportUnavailableError(state);
    }
    if (!pool) throw new NoOperatorsChosenError();
    startPinCheck();
    const signal = AbortSignal.any([lifetime.signal, selection.signal]);
    const gated = gateReader(pooledReader(pool, headers), abortable(pinCheck!, signal));
    const guarded = {} as Record<keyof VerifiedReader, (...args: never[]) => Promise<unknown>>;
    for (const name of ["getBalance", "getTransactionCount", "getCode", "getStorageAt", "getTokenBalance"] as const) {
      guarded[name] = async (...args: never[]) => {
        signal.throwIfAborted();
        const value = await abortable((gated[name] as (...a: never[]) => Promise<unknown>)(...args), signal);
        signal.throwIfAborted();
        return value;
      };
    }
    return guarded as unknown as VerifiedReader;
  }

  function setOperators(operators: DeRPCOperator[]) {
    lifetime.signal.throwIfAborted();
    validateOperators(operators);
    const next = operators.map(o => ({ ...o, gateways: o.gateways ? [...o.gateways] : undefined, wrapperIdentity: o.wrapperIdentity ? { ...o.wrapperIdentity } : undefined, payment: o.payment ? { ...o.payment } : undefined }));
    selection.abort(new Error("operator selection changed"));
    selection = new AbortController();
    if (pinStatus.state === "checking") pinCheck = undefined;
    chosenOperators = next;
    personalHeaders.clear();
    for (const operator of next) {
      if (operator.personalToken) {
        personalHeaders.set(new URL(operator.url).origin, { authorization: `Bearer ${operator.personalToken}` });
        continue; // Private credentials never belong in the retained payment endpoint maps.
      }
      const id = operator.paymentOperatorId ?? operator.id ?? operator.url;
      knownOperators.set(id, operator);
      if (options.payments?.has(id)) pinPaymentEndpoint(id, operator);
    }
    pool = next.length
      ? createPool({
          endpoints: next,
          sendFor,
          prepareAttempt,
          signal: AbortSignal.any([lifetime.signal, selection.signal]),
          excluded,
          onEvent: (event) => {
            if (event.type === "invalid-proof" && event.endpoint) excluded.add(event.endpoint);
            options.onPoolEvent?.(event);
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
    if (headerSource) lc = { ...lc, poll: headerSource.pollHealth() };
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
  for (const name of ["getBalance", "getTransactionCount", "getCode", "getStorageAt", "getTokenBalance"] as const) {
    reader[name] = async (...args: never[]) => ((await readerForReads())[name] as (...a: never[]) => Promise<unknown>)(...args);
  }

  if (initialOperators.length) setOperators(initialOperators);
  initialOperators = [];
  live = true;
  queueMicrotask(notify);

  return {
    provider,
    reader: reader as unknown as VerifiedReader,
    ready: headersReady.then(() => undefined),
    setOperators,
    refreshDirectory,
    verifiedCall,
    registerPaymentOperator,
    settlePayment,
    status,
    close() {
      transport.close();
      headerSource?.close();
      disconnect("closed by the app");
      personalHeaders.clear();
      chosenOperators = [];
      pool = undefined;
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
    ...base,
    id: `simulated-liar:${base.id ?? base.url}`,
    paymentOperatorId: base.paymentOperatorId ?? base.id ?? base.url,
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

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { work.catch(() => {}); reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
