import { MAINNET_BEACON_ENDPOINTS, MAINNET_CHECKPOINT, TOR_JS_PIN, withGateways, type WorkerPin } from "../config/mainnet.ts";
import {
  startVerifiedHeaderSource,
  type HeaderSourceOptions,
  type VerifiedHeader,
  type PollHealth,
  type VerifiedHeaderSource,
} from "../light-client/header-source.ts";
import { assertOperatorActive, createPool, NoOperatorsChosenError, operatorKey, type EndpointStatus, type Pool, type PoolEndpoint, type PoolEvent, type PoolOperationContext, type PoolAttemptLifecycle, type SelectionMode } from "../pool/pool.ts";
import { createPooledReader } from "../pool/pooled-reader.ts";
import {
  startAnonTransport,
  NetworkUnavailableError,
  TransportUnavailableError,
  type AnonTransport,
  type StartOptions,
  type TransportState,
  type WorkerLogLine,
} from "../transport/anon-transport.ts";
import { asFetch } from "../transport/fetch-adapter.ts";
import { createJsonRpcSend } from "../transport/json-rpc.ts";
import { ProofVerificationError, type AccountProof } from "../verify/index.ts";
import { InputError, type HeaderView, type JsonRpcSend, type VerifiedReader, type VerifiedValue } from "../verify/reader.ts";
import { checkWorkerPin, gateReader, WorkerPinChainError, WorkerPinMismatchError } from "../verify/worker-pin.ts";
import { createEip1193Provider, ProviderRpcError, type Eip1193Provider } from "./eip1193.ts";
import { assertSeparateGateway, checkOperatorIdentity, operatorUrl } from "../operators/endpoint.ts";
import { MAX_OPERATOR_ENDPOINTS } from "../operators/endpoints.ts";
import { readResponseBody } from "../transport/response-body.ts";
import type { Directory, PaymentTerms } from "../discovery/ens.ts";
import type { RegistrarPin } from "../discovery/registrar.ts";
import type { ExecutionLimits } from "../execution/index.ts";
import type { VerifiedEnsOptions, VerifiedEnsResult } from "../execution/verified-ens.ts";
import { DirectorySnapshotLease, DirectorySnapshotExpiredError, type DirectorySnapshotStatus } from "./directory-snapshot.ts";
export { DIRECTORY_SNAPSHOT_TTL_MS, DIRECTORY_SNAPSHOT_MAX_BLOCK_AGE_MS, DirectorySnapshotExpiredError, type DirectorySnapshotStatus } from "./directory-snapshot.ts";

type Hex = `0x${string}`;

/** An operator the user chose. */
export type DeRPCOperator = PoolEndpoint & {
  /** Owner proven from the ENS listing. Caller-supplied claims alone do not authorize continuity. */
  ensOwner?: Hex;
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
  /** Explicit candidates. Omitted selection keeps the legacy manual choice; omitted operators select none. */
  operators?: readonly DeRPCOperator[];
  /** Opt into free automatic routing across the supplied candidates. */
  selection?: SelectionMode;
  /** Automatic routing only: omitted permits every operator; [] permits none. Group/ENS IDs, never plural endpoint IDs. */
  allowedOperators?: string[];
  /** Only Ethereum mainnet (1) has a configured verifier. */
  chainId?: number;
  /** tor-js gateway (KPS) addresses. Default: the pinned demo gateway. */
  gateways?: string[];
  /** The pinned anonymity worker. Default: tor-js 0.4.4. */
  worker?: WorkerPin;
  /** The light client's trusted checkpoint. Default: the one shipped with this build. */
  checkpoint?: { epoch: number; root: Hex };
  /** Beacon API for the light client (reached through the worker). */
  beaconUrl?: string;
  beaconUrls?: readonly string[];
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
export type ResolveEnsRequest = Pick<VerifiedEnsOptions, "name" | "record" | "signal" | "limits">;
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

export interface RoutingOptions {
  selection: "manual" | SelectionMode;
  /** Omitted means all candidates in automatic mode. An empty list always means none. */
  allowedOperators?: string[];
}

export interface RoutingStatus extends RoutingOptions {
  /** Explicit candidates have not acquired ENS provenance merely by carrying an ENS-shaped label. */
  source: "explicit" | "verified-ens" | "unverified-ens";
  directory?: "derpc.eth";
  directorySnapshot?: DirectorySnapshotStatus;
}

export interface DeRPCStatus {
  chainId: number;
  worker: { name: string; workerHash: Hex };
  checkpoint: { epoch: number; root: Hex };
  transport: { state: TransportState; error?: string };
  /** Last observed anonymous fetch outcome; not a guarantee that every endpoint is reachable. */
  network?: { state: "ok" | "unavailable"; error?: string };
  lightClient: { state: "waiting" | "syncing" | "verified" | "stale" | "failed"; header?: VerifiedHeader; error?: string; poll?: PollHealth };
  pin: { state: "waiting-for-operators" | "waiting-for-light-client" | "checking" | "verified" | "mismatch" | "failed"; workerHash?: Hex; block?: number; error?: string };
  operators: EndpointStatus[];
  /** Present on this provider; optional for consumers supplying older status fixtures. */
  routing?: RoutingStatus;
}

export interface DeRPC {
  /** EIP-1193 provider for proven reads (use with viem through `derpcTransport`). */
  readonly provider: Eip1193Provider;
  /** The same reads with their proof context (value plus the verified block), and ERC-20 balances. */
  readonly reader: VerifiedReader;
  /** Resolves when the worker runs and the light client has verified a fresh header. Rejects for good on failure. */
  readonly ready: Promise<void>;
  /** Replace the user's choice; expired listings are refused and session exclusions carry over. */
  setOperators(operators: readonly DeRPCOperator[]): void;
  /** Change policy and optionally replace explicit candidates in one atomic selection change. */
  setRouting(routing: RoutingOptions, operators?: readonly DeRPCOperator[]): void;
  /** Manual: retain chosen names. Automatic: adopt all permitted free entries from a proven ENS snapshot. */
  refreshDirectory(options: RefreshDirectoryOptions): Promise<Directory>;
  /** Locally execute against proven state; disabled unless verifiedCalls was explicitly enabled. */
  verifiedCall(input: VerifiedCallInput): Promise<VerifiedValue<Hex>>;
  /** Resolve a fully on-chain ENS record locally at one authenticated block; requires verifiedCalls. */
  resolveEns(request: ResolveEnsRequest): Promise<VerifiedEnsResult>;
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
  if (options.chainId !== undefined && options.chainId !== CHAIN_ID) throw new Error("only Ethereum mainnet chainId 1 is supported");
  let routing = normalizeRouting({ selection: options.selection === undefined ? "manual" : options.selection, allowedOperators: options.allowedOperators });
  // Initial operator credentials must not survive through the long-lived options closure.
  let initialOperators = options.operators === undefined ? [] : options.operators;
  options = { ...options, operators: undefined, allowedOperators: undefined };
  const basePin = options.worker ?? TOR_JS_PIN;
  const pin = options.gateways?.length ? withGateways(basePin, options.gateways) : basePin;
  const checkpoint = options.checkpoint ?? MAINNET_CHECKPOINT;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 20_000;
  const callTimeoutMs = typeof options.verifiedCalls === "object" ? options.verifiedCalls.limits?.timeoutMs ?? 60_000 : 60_000;
  const lifetime = new AbortController();
  let selection = new AbortController();
  let chosenOperators: DeRPCOperator[] = [];
  let candidateOperators: DeRPCOperator[] = [];
  let source: RoutingStatus["source"] = "explicit";
  // Explicit free candidates may recover directory discovery after every listed operator was removed.
  // They are never installed as a fallback for user reads, and the current allowlist still applies.
  let discoveryBootstrap: DeRPCOperator[] = [];
  let provenDirectory: { operators: readonly DeRPCOperator[]; block: VerifiedHeader; lease: DirectorySnapshotLease } | undefined;
  const authenticatedGroups = new WeakMap<DirectorySnapshotLease, Set<string>>();
  let readSnapshot: DirectorySnapshotLease | undefined;
  // A lease can be reused by a same-block refresh. Keep the selected pool's evidence immutable so
  // newly discovered groups cannot retroactively authenticate an earlier explicit owner claim.
  let readAuthenticatedGroups: ReadonlySet<string> = new Set();
  const knownDirectoryKeys = new Set<string>();
  let refreshGeneration = 0;
  let activeRefresh: AbortController | undefined;
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
  function validateOperators(operators: readonly DeRPCOperator[], forSettlement = false) {
    if (!Array.isArray(operators)) throw new Error("operators must be an array");
    const groupCounts = new Map<string, number>();
    for (const operator of operators) {
      if (!operator || typeof operator !== "object") throw new Error("invalid operator");
      if (operator.operatorId !== undefined && (typeof operator.operatorId !== "string" || !operator.operatorId.length || operator.operatorId.length > 255 || /\s/.test(operator.operatorId))) throw new Error("invalid operator group ID");
      if (operator.endpointId !== undefined && (typeof operator.endpointId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(operator.endpointId) || !operator.operatorId || !operator.id)) throw new Error("endpoint IDs require an explicit operator group, endpoint key and a 1–31 character lowercase label");
      const key = operatorKey(operator);
      groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
    }
    for (const operator of operators) {
      if (!operator || typeof operator !== "object") throw new Error("invalid operator");
      // An expired listing can still receive the final voucher for an existing funded session.
      assertOperatorActive(operator, forSettlement ? 0 : Date.now());
      const endpoint = operatorUrl(operator.url);
      assertSeparateGateway(operator, gateways, options.gatewayOwners);
      if (operator.beaconUrl) operatorUrl(operator.beaconUrl);
      if (operator.wrapperIdentity && (!operator.ens || !/^0x[\da-fA-F]{40}$/.test(operator.wrapperIdentity.signer))) throw new Error("wrapper requires an ENS name and signer");
      if (operator.ensOwner !== undefined && (!operator.ens || !/^0x[\da-fA-F]{40}$/.test(operator.ensOwner) || /^0x0{40}$/i.test(operator.ensOwner))) throw new Error("ENS owner requires a name and a nonzero public address");
      const knownPlural = provenDirectory?.operators.some(record => record.endpointId !== undefined && directoryKeys(record).some(key => directoryKeys(operator).includes(key)));
      const plural = operator.endpointId !== undefined || (groupCounts.get(operatorKey(operator)) ?? 0) > 1 || knownPlural;
      if (plural && (operator.payment || operator.paymentOperatorId && !operator.tamper || options.payments?.has(operator.paymentOperatorId ?? operator.id ?? operator.url) || options.payments?.has(operatorKey(operator)))) throw new InputError("paid multi-endpoint operators are not supported; keep funded sessions on their original single endpoint");
      if (operator.personalToken !== undefined) {
        if (!endpoint.hostname.endsWith(".onion") || !/^[a-f0-9]{64}$/.test(operator.personalToken) || operator.ens || operator.wrapperIdentity) throw new Error("personal mode requires an unpublished onion and a 32-byte token");
        if (operator.beaconUrl && new URL(operator.beaconUrl).origin !== endpoint.origin) throw new Error("personal beacon must share the private onion");
        if (operator.payment) throw new Error("personal nodes do not take payments");
      }
    }
    validateEndpointGroups(operators);
  }
  // Validate the complete candidate source without accepting already-expired manual choices.
  validateOperators(initialOperators, routing.selection !== "manual");
  const initialChosen = permittedOperators(initialOperators, routing);
  validateAutomaticIdentities(permittedOperators(initialOperators, { selection: routing.selection }), routing);
  const operatorBeacons = initialChosen.flatMap(o => o.beaconUrl ? [o.beaconUrl] : []);
  const beaconUrls = [...new Set([...(options.beaconUrl ? [options.beaconUrl] : []), ...(options.beaconUrls ?? []), ...operatorBeacons])];
  if (!beaconUrls.length) beaconUrls.push(...MAINNET_BEACON_ENDPOINTS);
  for (const beacon of beaconUrls) operatorUrl(beacon);
  const personalHeaders = new Map<string, Record<string, string>>();
  const consensusFetch = (transport: AnonTransport, attempt: number) => asFetch(transport, {
    isolationKey: `derpc:consensus:${attempt}`,
    headersForUrl: url => personalHeaders.get(new URL(url).origin) ?? {},
  });

  let transportError: string | undefined;
  let network: NonNullable<DeRPCStatus["network"]> = { state: "ok" };
  let lightClient: { state: "waiting" | "syncing" | "verified" | "failed"; error?: string } = { state: "waiting" };
  let headerSource: VerifiedHeaderSource | undefined;
  let pool: Pool | undefined;
  const pooledReaders = new WeakMap<Pool, VerifiedReader>();
  // Remember rejected destinations, not caller-editable node IDs. A proven URL rotation gets a
  // fresh observation history, while relabeling an old destination cannot erase its local exclusion.
  const excludedDestinations = new Set<string>();
  const destinationKey = (operator: DeRPCOperator) => operatorUrl(operator.url).href;
  const simulatedKey = (operator: DeRPCOperator) => `simulated:${operator.id ?? operator.url}:${destinationKey(operator)}`;
  const destinationExcluded = (operator: DeRPCOperator) => excludedDestinations.has(destinationKey(operator)) || !!operator.tamper && excludedDestinations.has(simulatedKey(operator));
  const excludedIds = (operators: readonly DeRPCOperator[]) => operators.filter(destinationExcluded).map(operator => operator.id ?? operator.url);
  function excludeDestination(operator: DeRPCOperator): void { excludedDestinations.add(operator.tamper ? simulatedKey(operator) : destinationKey(operator)); }
  function assertDestinationAllowed(operator: DeRPCOperator): void {
    if (destinationExcluded(operator)) throw new ProofVerificationError("endpoint destination was excluded locally");
  }
  let pinCheck: Promise<unknown> | undefined;
  let pinStatus: DeRPCStatus["pin"] = { state: "waiting-for-operators" };
  let disconnected = false;
  // Status goes out only once createDeRPC has returned: the transport reports "booting" while it starts.
  let live = false;
  const notify = () => {
    if (live) { try { options.onStatus?.(status()); } catch { /* app observer */ } }
  };

  function assertDirectoryAuthority(lease = readSnapshot): void {
    if (!lease) return;
    lease.assertFresh();
    try { headerSource?.assertFresh(lease.block); }
    catch (error) {
      const expired = new DirectorySnapshotExpiredError("authenticated block is stale", { cause: error });
      lease.expire(expired);
      throw expired;
    }
  }

  function userReadSignal(): AbortSignal {
    assertDirectoryAuthority();
    return AbortSignal.any([lifetime.signal, selection.signal, ...(readSnapshot ? [readSnapshot.controller.signal] : [])]);
  }

  function assertDirectoryOperator(operator: DeRPCOperator, lease?: DirectorySnapshotLease): void {
    if (!lease) return; // Administrative pools use only explicit, retained bootstrap authorization.
    assertDirectoryAuthority(lease);
    if (provenDirectory?.lease !== lease) throw new DirectorySnapshotExpiredError("was replaced");
    const record = provenDirectory.operators.find(candidate => operatorUrl(candidate.url).href === operatorUrl(operator.url).href);
    if (record) assertOperatorActive(record); // Caller-supplied expiry cannot extend an authenticated lease.
  }

  function authorityForOperators(operators: readonly DeRPCOperator[]): DirectorySnapshotLease | undefined {
    const known = operators.filter(operator => directoryKeys(operator).some(key => knownDirectoryKeys.has(key)));
    if (!known.length) return undefined;
    if (!provenDirectory) throw new DirectorySnapshotExpiredError("is unavailable");
    for (const operator of known) {
      const current = provenDirectory.operators.find(record => operatorUrl(record.url).href === operatorUrl(operator.url).href &&
        (!operator.ens || record.ens?.toLowerCase() === operator.ens.toLowerCase()) &&
        (!operator.ensOwner || record.ensOwner?.toLowerCase() === operator.ensOwner.toLowerCase()) &&
        (!operator.wrapperIdentity || record.wrapperIdentity?.signer.toLowerCase() === operator.wrapperIdentity.signer.toLowerCase()) &&
        (!!operator.tamper || (record.endpointId === undefined
          ? !operator.operatorId || operatorKey(record) === operatorKey(operator)
          : operator.id === record.id && operator.operatorId === record.operatorId && operator.endpointId === record.endpointId &&
            (!record.ensOwner || operator.ensOwner?.toLowerCase() === record.ensOwner.toLowerCase()) &&
            (!record.wrapperIdentity || operator.wrapperIdentity?.signer.toLowerCase() === record.wrapperIdentity.signer.toLowerCase()))));
      if (!current) throw new DirectorySnapshotExpiredError("identity was removed or its endpoint changed");
    }
    return provenDirectory.lease;
  }

  const { provider, emit } = createEip1193Provider({
    chainId: CHAIN_ID, headers: readyHeaders, reader: readerForReads,
    requestSignal: userReadSignal,
    verifiedCall: typeof options.verifiedCalls === "object" && options.verifiedCalls.eip1193 ? verifiedCall : undefined,
  });

  function disconnect(reason: string, state: "closed" | "failed" = "closed") {
    if (disconnected) return;
    disconnected = true;
    lifetime.abort(new TransportUnavailableError(state));
    emit("disconnect", new ProviderRpcError(4900, reason, { reason: "TransportUnavailableError" }));
  }

  const startedTransport = deps.startTransport({
    pin,
    onLog: line => { try { options.onWorkerLog?.(line); } catch { /* app observer */ } },
    onState: (state, detail) => {
      if (detail) transportError = detail;
      if (state === "failed" || state === "closed") disconnect(`anonymous transport ${state}${detail ? `: ${detail}` : ""}`, state);
      notify();
    },
  });

  const transport: AnonTransport = {
    pin: startedTransport.pin,
    ready: startedTransport.ready,
    state: () => startedTransport.state(),
    async fetch(url, init) {
      try {
        const response = await startedTransport.fetch(url, init);
        network = { state: "ok" };
        return response;
      } catch (error) {
        if (error instanceof NetworkUnavailableError) network = { state: "unavailable", error: error.message };
        throw error;
      } finally { notify(); }
    },
    close: () => startedTransport.close(),
  };

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

  function sendFor(endpoint: PoolEndpoint, authority?: DirectorySnapshotLease): JsonRpcSend {
    const operator = endpoint as DeRPCOperator;
    const rawSend = createJsonRpcSend(transport, endpoint.url, {
      timeoutMs: attemptTimeoutMs,
      headers: operator.personalToken ? { authorization: `Bearer ${operator.personalToken}` } : undefined,
    });
    return async (method, params, opts) => {
      try {
      assertDestinationAllowed(operator);
      assertDirectoryOperator(operator, authority);
      assertOperatorActive(operator);
      if (operator.wrapperIdentity) {
        const key = JSON.stringify([operator.url, operator.ens, operator.operatorId, operator.endpointId, operator.wrapperIdentity.signer]);
        let check = checkedIdentities.get(key);
        if (!check) {
          check = checkOperatorIdentity(transport, endpoint.url, { ens: operator.ens!, signer: operator.wrapperIdentity.signer, endpointId: operator.endpointId }, lifetime.signal).then(() => undefined);
          checkedIdentities.set(key, check);
          check.catch(() => { if (checkedIdentities.get(key) === check) checkedIdentities.delete(key); });
        }
        await abortable(check, opts.signal ?? lifetime.signal);
      }
      // Identity lookup may have crossed the listing deadline while this request was waiting.
      assertDestinationAllowed(operator);
      assertDirectoryOperator(operator, authority);
      assertOperatorActive(operator);
      const result = await rawSend(method, params, opts);
      assertDestinationAllowed(operator);
      assertDirectoryOperator(operator, authority);
      return operator.tamper ? operator.tamper(method, result) : result;
      } catch (error) {
        // A request deadline may report before the lease timer runs. Expired authority is local,
        // not evidence of an unavailable or dishonest endpoint.
        assertDirectoryOperator(operator, authority);
        throw error;
      }
    };
  }

  async function prepareAttempt(context: PoolOperationContext, send: JsonRpcSend, authority?: DirectorySnapshotLease): Promise<PoolAttemptLifecycle> {
    context.signal.throwIfAborted();
    const operator = context.endpoint as DeRPCOperator;
    assertDestinationAllowed(operator);
    assertDirectoryOperator(operator, authority);
    const assertCurrent = () => {
      context.signal.throwIfAborted();
      assertDestinationAllowed(operator);
      assertDirectoryOperator(operator, authority);
    };
    const id = operator.paymentOperatorId ?? operator.id ?? operator.url;
    // Automatic routing is the free rollout. A previously funded session must not silently activate it.
    if (routing.selection !== "manual" || !context.paid || operator.personalToken) return { send, verified: async () => { assertCurrent(); } };
    if ((operator.endpointId !== undefined || chosenOperators.filter(candidate => operatorKey(candidate) === operatorKey(operator)).length > 1) &&
      (options.payments?.has(id) || options.payments?.has(operatorKey(operator)))) throw new InputError("paid multi-endpoint operators are not supported");
    if (!options.payments?.has(id)) {
      if (operator.payment) throw new Error(`open a funded test-payment session for ${operator.ens ?? id} before reading`);
      return { send, verified: async () => { assertCurrent(); } };
    }
    pinPaymentEndpoint(id, operator);
    const payment = await options.payments.begin(id, context.kind, { signal: context.signal });
    try { assertCurrent(); }
    catch (error) { payment.failed(); throw error; }
    return {
      send: (method, params, opts) => send(method, params, { ...opts, headers: { ...opts.headers, ...payment.headers() } }),
      verified: async () => {
        assertCurrent();
        const result = await payment.verified(context.signal);
        assertCurrent();
        return result;
      },
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
    const currentSelection = selection;
    const authority = readSnapshot;
    const signal = AbortSignal.any([userReadSignal(), ...(callerSignal ? [callerSignal] : [])]);
    const headers = await abortable(readyHeaders(), signal);
    signal.throwIfAborted();
    if (!pool) throw new NoOperatorsChosenError();
    const currentPool = pool;
    startPinCheck();
    await abortable(pinCheck!, signal);
    currentSelection.signal.throwIfAborted();
    assertDirectoryAuthority(authority);
    return { headers, currentPool, block: headers.finalized() };
  }

  async function verifiedCall(input: VerifiedCallInput): Promise<VerifiedValue<Hex>> {
    if (!options.verifiedCalls) throw new ProviderRpcError(4200, "enable verifiedCalls to execute a call locally against proven state");
    const requestSelection = selection;
    const authority = readSnapshot;
    const authoritySignal = userReadSignal();
    const { createVerifiedExecutor, assertVerifiedCallInput } = await import("../execution/index.ts");
    assertVerifiedCallInput(input);
    const requestSignal = AbortSignal.any([authoritySignal, requestSelection.signal, ...(input.signal ? [input.signal] : [])]);
    const { headers, currentPool, block } = await readContext(requestSignal);
    const pinned: HeaderView = { finalized: () => block, assertFresh: header => headers.assertFresh(header) };
    const result = await currentPool.run(async (send, context) => {
      const executor = createVerifiedExecutor({ headers: pinned, send, limits: typeof options.verifiedCalls === "object" ? options.verifiedCalls.limits : undefined });
      const result = await executor.call({ ...input, signal: context.signal });
      headers.assertFresh(result.block);
      return result;
    }, { account: input.from ?? input.to, kind: "call", signal: requestSignal, totalTimeoutMs: callTimeoutMs, assertValid: () => { assertDirectoryAuthority(authority); headers.assertFresh(block); } });
    assertDirectoryAuthority(authority);
    headers.assertFresh(result.block);
    return result;
  }

  async function resolveEns(request: ResolveEnsRequest): Promise<VerifiedEnsResult> {
    if (!options.verifiedCalls) throw new ProviderRpcError(4200, "enable verifiedCalls to resolve ENS against proven state");
    if (!request || typeof request !== "object" || Array.isArray(request) || Reflect.ownKeys(request).some(key => typeof key !== "string" || !["name", "record", "signal", "limits"].includes(key))) throw new InputError("invalid ENS resolution request");
    const authority = readSnapshot;
    // Capture the complete route authorization before importing code or waiting for headers.
    const signal = AbortSignal.any([userReadSignal(), ...(request.signal ? [request.signal] : [])]);
    const [{ resolveVerifiedEns }, { createVerifiedExecutor }] = await Promise.all([
      import("../execution/verified-ens.ts"), import("../execution/index.ts"),
    ]);
    signal.throwIfAborted();
    const { headers, currentPool, block } = await readContext(signal);
    const pinned: HeaderView = { finalized: () => block, assertFresh: header => { assertDirectoryAuthority(authority); headers.assertFresh(header); } };
    const result = await resolveVerifiedEns({ ...request, headers: pinned, signal,
      // The helper validates/normalizes the name before this callback can reserve a paid read.
      verifiedCall: input => currentPool.run(async (send, context) => {
        signal.throwIfAborted();
        const executor = createVerifiedExecutor({ headers: pinned, send, limits: typeof options.verifiedCalls === "object" ? options.verifiedCalls.limits : undefined });
        return executor.call({ ...input, signal: AbortSignal.any([signal, context.signal, ...(input.signal ? [input.signal] : [])]) });
      }, { account: "derpc:ens-resolution", kind: "call", signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal, totalTimeoutMs: callTimeoutMs,
        assertValid: () => { assertDirectoryAuthority(authority); headers.assertFresh(block); } }),
    });
    signal.throwIfAborted();
    assertDirectoryAuthority(authority);
    headers.assertFresh(result.block);
    return result;
  }

  async function refreshDirectory(request: RefreshDirectoryOptions): Promise<Directory> {
    lifetime.signal.throwIfAborted();
    const automatic = routing.selection !== "manual";
    if (automatic && (!request.verifiedRecords || !request.registrar)) throw new Error("automatic routing requires proven ENS records and a pinned registrar");
    if (request.verifiedRecords && !options.verifiedCalls) throw new ProviderRpcError(4200, "enable verifiedCalls before requesting proven ENS records");
    const generation = ++refreshGeneration;
    activeRefresh?.abort(new Error("directory refresh superseded"));
    const refreshing = new AbortController();
    activeRefresh = refreshing;
    const originalSelection = selection;
    const signal = AbortSignal.any([lifetime.signal, originalSelection.signal, refreshing.signal, ...(request.signal ? [request.signal] : [])]);
    try {
    const { headers, currentPool, block, executionUrl } = await directoryReadContext(signal);
    const pinned: HeaderView = { finalized: () => block, assertFresh: header => headers.assertFresh(header) };
    const { discoverOperators, retainChosenOperators, readProvenOperators } = await import("../discovery/ens.ts");
    const { createVerifiedExecutor } = request.verifiedRecords ? await import("../execution/index.ts") : { createVerifiedExecutor: undefined };
    const totalTimeoutMs = request.totalTimeoutMs ?? 120_000;
    const directory = await discoverOperators({
      transport, executionUrl, headers: pinned, ethRegistry: request.ethRegistry,
      gatewayOwners: options.gatewayOwners,
      registrar: request.registrar, signal, totalTimeoutMs,
      // Raw ENS calls remain internal and unverified. A paid wrapper may refuse these;
      // verifiedRecords uses the local executor below and never sends eth_call upstream.
      send: (method, params, opts) => currentPool.run(send => send(method, params, opts), { paid: false, observe: false, signal: opts.signal ?? signal }),
      // Each completed local call is one logical read, keeping payment authorizations bounded
      // independently of directory size. Verification/freshness finish before the pool signs.
      verifiedCall: createVerifiedExecutor ? (to, data, opts) => currentPool.run(async (send, context) => {
        const executor = createVerifiedExecutor({ headers: pinned, send, limits: typeof options.verifiedCalls === "object" ? options.verifiedCalls.limits : undefined });
        const result = await executor.call({ to, data, signal: context.signal });
        headers.assertFresh(result.block);
        return result;
      }, { kind: "call", account: "derpc:operator-discovery", paid: false, signal: opts?.signal ?? signal, totalTimeoutMs: callTimeoutMs, assertValid: () => headers.assertFresh(block) }) : undefined,
      readRegistrar: (registrar, opts) => currentPool.run(async (send, context) => {
        const result = await readProvenOperators({ headers: pinned, send, registrar, signal: context.signal });
        headers.assertFresh(result.block);
        return result;
      }, { kind: "call", account: "derpc:operator-discovery", paid: false, signal: opts?.signal ?? signal, totalTimeoutMs, assertValid: () => headers.assertFresh(block) }),
    });
    signal.throwIfAborted();
    headers.assertFresh(block);
    if (generation !== refreshGeneration) throw new Error("directory refresh superseded");
    if (directory.blockNumber !== block.blockNumber || directory.blockHash !== block.blockHash) throw new Error("directory changed its authenticated block");
    const proven = directory.listVerification === "proven" && directory.recordVerification === "proven";
    if (automatic && !proven) throw new Error("automatic routing refuses an unverified ENS directory");
    // Revalidate before changing either candidates or provenance; callers cannot race a newer policy.
    validateOperators(directory.operators, automatic);
    if (automatic) validateAutomaticIdentities(permittedOperators(directory.operators, routing), routing);
    const previousDirectory = provenDirectory;
    const previousKeys = new Set(knownDirectoryKeys);
    let previousGroupBindings: Set<string> | undefined;
    if (proven) {
      if (previousDirectory && (block.blockNumber < previousDirectory.block.blockNumber ||
        block.blockNumber === previousDirectory.block.blockNumber && (block.blockHash !== previousDirectory.block.blockHash || block.stateRoot !== previousDirectory.block.stateRoot))) {
        throw new Error("directory snapshot cannot move backwards or change an authenticated block");
      }
      // Re-proving the same finalized block can change availability, but not renew its authority.
      const lease = previousDirectory?.block.blockHash === block.blockHash ? previousDirectory.lease : new DirectorySnapshotLease({ ...block }, notify);
      lease.assertFresh();
      previousGroupBindings = authenticatedGroups.get(lease);
      authenticatedGroups.set(lease, new Set(directory.operators.map(authenticatedOperatorIdentity).filter((identity): identity is string => identity !== undefined)));
      provenDirectory = { operators: cloneOperators(directory.operators), block: { ...block }, lease };
      directory.operators.forEach(operator => directoryKeys(operator).forEach(key => knownDirectoryKeys.add(key)));
    }
    if (activeRefresh === refreshing) activeRefresh = undefined;
    try {
      if (automatic) replaceCandidates(directory.operators, routing, "verified-ens");
      else {
        const retained = retainChosenOperators(directory, chosenOperators.flatMap(o => o.ens ? [o.ens] : []));
        // Personal endpoints are never published into ENS and are not removed by a public registry.
        const next = [...chosenOperators.filter(o => !!o.personalToken), ...retained];
        replaceCandidates(next, routing, proven && !next.some(o => !!o.personalToken) ? "verified-ens" : "unverified-ens");
      }
    } catch (error) {
      if (provenDirectory) {
        if (previousGroupBindings) authenticatedGroups.set(provenDirectory.lease, previousGroupBindings);
        else authenticatedGroups.delete(provenDirectory.lease);
      }
      if (provenDirectory?.lease !== previousDirectory?.lease) provenDirectory?.lease.dispose();
      provenDirectory = previousDirectory;
      knownDirectoryKeys.clear(); previousKeys.forEach(key => knownDirectoryKeys.add(key));
      throw error;
    }
    if (previousDirectory?.lease !== provenDirectory?.lease) previousDirectory?.lease.dispose();
    return directory;
    } finally {
      if (activeRefresh === refreshing) activeRefresh = undefined;
      refreshing.abort(new Error("directory refresh finished"));
    }
  }

  async function directoryReadContext(signal: AbortSignal): Promise<{ headers: VerifiedHeaderSource; currentPool: Pool; block: VerifiedHeader; executionUrl: string }> {
    let snapshotFresh = true;
    try { assertDirectoryAuthority(); } catch (error) {
      if (!(error instanceof DirectorySnapshotExpiredError)) throw error;
      snapshotFresh = false;
    }
    if (pool && snapshotFresh) {
      const context = await readContext(signal);
      return { ...context, executionUrl: chosenOperators[0]!.url };
    }
    if (routing.selection === "manual" && snapshotFresh && !provenDirectory) throw new NoOperatorsChosenError();
    // Recovery is only reached by this explicitly requested administrative scan. An empty allowlist
    // still denies every endpoint; no bootstrap candidate ever becomes the public reader's pool.
    const bootstrap = permittedOperators(discoveryBootstrap, routing.selection === "manual" ? { selection: "balanced" } : routing);
    if (!bootstrap.length) throw new NoOperatorsChosenError();
    validateOperators(bootstrap);
    const headers = await abortable(readyHeaders(), signal);
    signal.throwIfAborted();
    if (pinStatus.state === "mismatch") await abortable(pinCheck!, signal);
    const currentPool = createPool({ endpoints: bootstrap, sendFor: endpoint => sendFor(endpoint), excluded: excludedIds(bootstrap), selection: routing.selection === "manual" ? undefined : routing.selection, signal,
      onEvent: event => {
        const endpoint = bootstrap.find(operator => (operator.id ?? operator.url) === event.endpoint);
        if (event.type === "invalid-proof" && endpoint) excludeDestination(endpoint);
      },
    });
    try {
      await checkWorkerPin({ pin, network: "mainnet", reader: createPooledReader({ pool: currentPool, headers, paid: false }) });
    } catch (error) {
      if (error instanceof WorkerPinMismatchError || error instanceof WorkerPinChainError) {
        pinStatus = { state: "mismatch", error: message(error) };
        pinCheck = Promise.reject(error);
        pinCheck.catch(() => {});
        notify();
      }
      throw error;
    }
    signal.throwIfAborted();
    return { headers, currentPool, block: headers.finalized(), executionUrl: bootstrap[0]!.url };
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
    if (operator.endpointId !== undefined || provenDirectory?.operators.some(record => record.endpointId !== undefined && directoryKeys(record).some(key => directoryKeys(operator).includes(key)))) throw new InputError("paid multi-endpoint operators are not supported");
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
    const authority = readSnapshot;
    const signal = userReadSignal();
    const headers = await abortable(readyHeaders(), signal);
    signal.throwIfAborted();
    const state = transport.state();
    if (state === "failed" || state === "closed") {
      throw new TransportUnavailableError(state);
    }
    if (!pool) throw new NoOperatorsChosenError();
    startPinCheck();
    const gated = gateReader(pooledReader(pool, headers), abortable(pinCheck!, signal));
    const guarded = {} as Record<keyof VerifiedReader, (...args: never[]) => Promise<unknown>>;
    for (const name of ["getBalance", "getTransactionCount", "getCode", "getStorageAt", "getTokenBalance"] as const) {
      guarded[name] = async (...args: never[]) => {
        signal.throwIfAborted();
        assertDirectoryAuthority(authority);
        const value = await abortable((gated[name] as (...a: never[]) => Promise<unknown>)(...args), signal);
        signal.throwIfAborted();
        assertDirectoryAuthority(authority);
        return value;
      };
    }
    return guarded as unknown as VerifiedReader;
  }

  function setOperators(operators: readonly DeRPCOperator[]) {
    replaceCandidates(operators, routing, provenSource(operators) ? "verified-ens" : "explicit");
  }

  function setRouting(nextRouting: RoutingOptions, operators?: readonly DeRPCOperator[]) {
    const next = normalizeRouting(nextRouting);
    const restoreDirectory = operators === undefined && routing.selection === "manual" && next.selection !== "manual" && source === "verified-ens" && provenDirectory;
    const candidates = operators === undefined ? (restoreDirectory ? restoreDirectory.operators : candidateOperators) : operators;
    const nextSource = operators === undefined ? source : provenSource(operators) ? "verified-ens" : "explicit";
    if (nextSource === "unverified-ens" && next.selection !== "manual" && permittedOperators(candidates, next).length) throw new Error("refresh proven ENS records before enabling automatic directory routing");
    replaceCandidates(candidates, next, nextSource);
  }

  function provenSource(operators: readonly DeRPCOperator[]): boolean {
    if (!provenDirectory || !Array.isArray(operators) || !operators.every(operator => provenDirectory!.operators.some(proven => sameOperator(operator, proven)))) return false;
    return true;
  }

  function replaceCandidates(operators: readonly DeRPCOperator[], nextRouting: RoutingOptions, nextSource: RoutingStatus["source"]) {
    lifetime.signal.throwIfAborted();
    validateOperators(operators, nextRouting.selection !== "manual");
    const candidates = cloneOperators(operators);
    const next = permittedOperators(candidates, nextRouting);
    validateAutomaticIdentities(permittedOperators(candidates, { selection: nextRouting.selection }), nextRouting);
    const nextSnapshot = authorityForOperators(next);
    if (nextSnapshot && next.some(operator => !chosenOperators.some(previous => sameOperatorIdentity(previous, operator)))) assertDirectoryAuthority(nextSnapshot);
    const previousPool = pool;
    const stableIds = next.filter(operator => chosenOperators.some(previous => sameOperatorIdentity(previous, operator))).map(operator => operator.id ?? operator.url);
    const stableOperatorIds = readSnapshot && nextSnapshot ? [...new Set(next.map(operatorKey))].filter(group => {
      const before = chosenOperators.filter(operator => operatorKey(operator) === group);
      const after = next.filter(operator => operatorKey(operator) === group);
      const identity = before[0] && authenticatedOperatorIdentity(before[0]);
      return identity !== undefined && readAuthenticatedGroups.has(identity) && authenticatedGroups.get(nextSnapshot)?.has(identity) &&
        [...before, ...after].every(operator => authenticatedOperatorIdentity(operator) === identity);
    }) : [];
    const sameCandidates = next.length === chosenOperators.length && next.every((operator, index) => sameOperator(operator, chosenOperators[index]!));
    const sameSourceCandidates = candidates.length === candidateOperators.length && candidates.every((operator, index) => sameOperator(operator, candidateOperators[index]!));
    const samePolicy = routing.selection === nextRouting.selection && sameAllowlist(routing.allowedOperators, nextRouting.allowedOperators);
    const sameSpendingPolicy = (routing.selection === "manual") === (nextRouting.selection === "manual");
    const sameAuthority = readSnapshot === nextSnapshot;
    const unchanged = sameCandidates && sameSourceCandidates && samePolicy && source === nextSource && sameAuthority;
    // A fresh manual source is an explicit administrative bootstrap authorization. Never retain secrets.
    if (nextSource === "explicit") {
      const explicit = candidates.filter(operator => !directoryKeys(operator).some(key => knownDirectoryKeys.has(key)));
      // Re-supplying ENS-derived records does not turn them into administrative bootstrap authority.
      if (explicit.length || !candidates.length) discoveryBootstrap = cloneOperators(permittedOperators(explicit, { selection: "balanced" }));
    }
    candidateOperators = candidates;
    routing = nextRouting;
    source = nextSource;
    readSnapshot = nextSnapshot;
    readAuthenticatedGroups = new Set(nextSnapshot ? authenticatedGroups.get(nextSnapshot) : []);
    if (unchanged) return;
    ++refreshGeneration;
    activeRefresh?.abort(new Error("operator routing changed"));
    // Changing only the category preserves account affinity, cooldowns and local measurements.
    if (sameCandidates && sameSpendingPolicy && sameAuthority && previousPool) {
      previousPool.setSelection(routing.selection === "manual" ? undefined : routing.selection);
      notify();
      return;
    }
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
          sendFor: endpoint => sendFor(endpoint, nextSnapshot),
          prepareAttempt: (context, send) => prepareAttempt(context, send, nextSnapshot),
          signal: AbortSignal.any([lifetime.signal, selection.signal, ...(nextSnapshot ? [nextSnapshot.controller.signal] : [])]),
          excluded: excludedIds(next),
          selection: routing.selection === "manual" ? undefined : routing.selection,
          preserveFrom: previousPool ? { pool: previousPool, ids: stableIds, operatorIds: stableOperatorIds } : undefined,
          onEvent: (event) => {
            const endpoint = next.find(operator => (operator.id ?? operator.url) === event.endpoint);
            if (event.type === "invalid-proof" && endpoint) excludeDestination(endpoint);
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
      network: { ...network },
      lightClient: lc,
      pin: pinStatus,
      operators: pool?.status() ?? [],
      routing: { ...routing, allowedOperators: routing.allowedOperators ? [...routing.allowedOperators] : undefined, source,
        ...(source === "verified-ens" ? { directory: "derpc.eth" as const } : {}),
        ...(provenDirectory ? { directorySnapshot: provenDirectory.lease.status(!!readSnapshot) } : {}) },
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
    setRouting,
    refreshDirectory,
    verifiedCall,
    resolveEns,
    registerPaymentOperator,
    settlePayment,
    status,
    close() {
      transport.close();
      headerSource?.close();
      disconnect("closed by the app");
      personalHeaders.clear();
      chosenOperators = [];
      candidateOperators = [];
      discoveryBootstrap = [];
      provenDirectory?.lease.dispose();
      provenDirectory = undefined;
      readSnapshot = undefined;
      readAuthenticatedGroups = new Set();
      knownDirectoryKeys.clear();
      excludedDestinations.clear();
      activeRefresh?.abort(lifetime.signal.reason);
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
    operatorId: `simulated-liar:${base.id ?? base.url}`,
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

function normalizeRouting(value: RoutingOptions): RoutingOptions {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["selection", "allowedOperators"].includes(key))) throw new Error("invalid routing options");
  if (!["manual", "balanced", "fastest", "reliable"].includes(value.selection)) throw new Error("unknown operator selection mode");
  const allowed = value.allowedOperators;
  if (allowed !== undefined) {
    if (value.selection === "manual") throw new Error("allowedOperators requires an automatic selection mode");
    if (!Array.isArray(allowed) || allowed.length > 128 || [...allowed].some(id => typeof id !== "string" || !id.length || id.length > 2048 || /\s/.test(id))) throw new Error("allowedOperators must contain at most 128 exact operator IDs or ENS names");
    if (new Set(allowed).size !== allowed.length) throw new Error("duplicate allowed operator");
  }
  return { selection: value.selection, ...(allowed === undefined ? {} : { allowedOperators: [...allowed] }) };
}

function permittedOperators(operators: readonly DeRPCOperator[], routing: RoutingOptions): DeRPCOperator[] {
  if (routing.selection === "manual") return [...operators];
  const allowlist = routing.allowedOperators === undefined ? undefined : new Set(routing.allowedOperators);
  return operators.filter(operator =>
    !operator.personalToken && !operator.payment && !operator.paymentOperatorId && !operator.tamper &&
    (operator.expiry === undefined || operator.expiry > Date.now() / 1000) &&
    (allowlist === undefined || allowlist.has(operatorKey(operator)) || !!operator.ens && allowlist.has(operator.ens) ||
      operator.endpointId === undefined && allowlist.has(operator.id ?? operator.url)));
}

function validateEndpointGroups(operators: readonly DeRPCOperator[]): void {
  const ids = new Set<string>();
  const urls = new Set<string>();
  const aliases = new Map<string, string>();
  const groups = new Map<string, DeRPCOperator[]>();
  for (const operator of operators) {
    const id = operator.id ?? operator.url;
    if (typeof id !== "string" || !id.length || ids.has(id)) throw new Error("endpoint keys must be unique");
    ids.add(id);
    if (operator.tamper) continue; // A deliberately simulated operator is its own manual demo group.
    const key = operatorKey(operator), group = groups.get(key) ?? [];
    const url = operatorUrl(operator.url).href;
    if (urls.has(url)) throw new Error("endpoint URLs must be unique");
    urls.add(url);
    for (const alias of [key, id, ...(operator.ens ? [operator.ens] : [])]) {
      const normalized = alias.toLowerCase();
      if (aliases.has(normalized) && aliases.get(normalized) !== key) throw new Error("one operator identity cannot be split across several groups");
      aliases.set(normalized, key);
    }
    group.push(operator); groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length > MAX_OPERATOR_ENDPOINTS) throw new Error("an operator can publish at most eight endpoints");
    const first = group[0]!, endpointIds = new Set<string>();
    for (const operator of group) {
      if (group.length > 1 && (!operator.operatorId || !operator.endpointId || endpointIds.has(operator.endpointId) ||
        operator.ens?.toLowerCase() !== first.ens?.toLowerCase() || operator.operator !== first.operator ||
        operator.wrapperIdentity?.signer.toLowerCase() !== first.wrapperIdentity?.signer.toLowerCase() || operator.ensOwner?.toLowerCase() !== first.ensOwner?.toLowerCase() || operator.expiry !== first.expiry)) {
        throw new Error("multiple endpoints require distinct node IDs and one consistent operator identity");
      }
      if (operator.endpointId) endpointIds.add(operator.endpointId);
    }
  }
}

function validateAutomaticIdentities(operators: readonly DeRPCOperator[], routing: RoutingOptions): void {
  if (routing.selection === "manual") return;
  // Group names, node keys and ENS aliases share one namespace, but only group aliases authorize routing.
  const identities = new Map<string, string>();
  const urls = new Set<string>();
  for (const operator of operators) {
    const url = operatorUrl(operator.url).href;
    const group = operatorKey(operator);
    if (urls.has(url)) throw new Error("automatic selection requires unique endpoint URLs");
    urls.add(url);
    for (const identity of [group, operator.id ?? operator.url, ...(operator.ens ? [operator.ens] : [])]) {
      if (typeof identity !== "string" || !identity.length) throw new Error("invalid automatic operator identity");
      const key = identity.toLowerCase();
      if (identities.has(key) && identities.get(key) !== group) throw new Error("ambiguous or duplicate automatic operator identity");
      identities.set(key, group);
    }
  }
}

function cloneOperators(operators: readonly DeRPCOperator[]): DeRPCOperator[] {
  return operators.map(operator => ({ ...operator, gateways: operator.gateways ? [...operator.gateways] : undefined,
    wrapperIdentity: operator.wrapperIdentity ? { ...operator.wrapperIdentity } : undefined,
    payment: operator.payment ? { ...operator.payment } : undefined }));
}

function sameAllowlist(a: string[] | undefined, b: string[] | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.length === b.length && a.every(id => b.includes(id));
}

function directoryKeys(operator: DeRPCOperator): string[] {
  const url = operatorUrl(operator.url).href;
  // IDs and ENS aliases share the allowlist namespace; moving a name between fields cannot erase provenance.
  return [`url:${url}`, `identity:${url.toLowerCase()}`, ...(operator.id ? [`identity:${operator.id.toLowerCase()}`] : []),
    ...(operator.operatorId ? [`identity:${operator.operatorId.toLowerCase()}`] : []),
    ...(operator.endpointId ? [`node:${operatorKey(operator).toLowerCase()}#${operator.endpointId}`] : []),
    ...(operator.ens ? [`identity:${operator.ens.toLowerCase()}`] : [])];
}

function sameOperatorIdentity(a: DeRPCOperator, b: DeRPCOperator): boolean {
  return a.id === b.id && a.url === b.url && a.ens === b.ens && a.ensOwner === b.ensOwner && a.operator === b.operator && a.operatorId === b.operatorId && a.endpointId === b.endpointId &&
    a.wrapperIdentity?.signer === b.wrapperIdentity?.signer && a.personalToken === b.personalToken &&
    a.paymentOperatorId === b.paymentOperatorId && a.tamper === b.tamper && a.beaconUrl === b.beaconUrl &&
    (a.gateways ?? []).join("\n") === (b.gateways ?? []).join("\n") &&
    a.payment?.chainId === b.payment?.chainId && a.payment?.escrow === b.payment?.escrow && a.payment?.payee === b.payment?.payee;
}

function authenticatedOperatorIdentity(operator: DeRPCOperator): string | undefined {
  if (!operator.operatorId || !operator.ens || !operator.ensOwner || !operator.wrapperIdentity || operator.tamper || operator.personalToken) return undefined;
  return JSON.stringify([operatorKey(operator), operator.ens.toLowerCase(), operator.ensOwner.toLowerCase(), operator.wrapperIdentity.signer.toLowerCase()]);
}

function sameOperator(a: DeRPCOperator, b: DeRPCOperator): boolean {
  return sameOperatorIdentity(a, b) && a.expiry === b.expiry && a.priority === b.priority &&
    a.payment?.price === b.payment?.price && a.payment?.payeeProven === b.payment?.payeeProven && a.payment?.recordsProven === b.payment?.recordsProven;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { work.catch(() => {}); reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
