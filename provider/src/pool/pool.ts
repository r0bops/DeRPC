import { HeaderSourceNotReadyError, StaleCheckpointError, StaleHeaderError } from "../light-client/header-source.ts";
import { TransportUnavailableError } from "../transport/anon-transport.ts";
import { ProofVerificationError } from "../verify/mpt.ts";
import type { JsonRpcSend } from "../verify/reader.ts";
import { WorkerPinChainError, WorkerPinMismatchError } from "../verify/worker-pin.ts";

export interface PoolEndpoint {
  /** Tells apart entries that share a URL (the simulated lying operator wraps a real one). Defaults to `url`. */
  id?: string;
  url: string;
  /** Lower is preferred in manual mode. Automatic modes consider all eligible operators. */
  priority: number;
  /** Who runs it, where known. Several URLs don't prove independent operators. */
  operator?: string;
  /** The operator's ENS name (mock until the ENS milestone). */
  ens?: string;
  /** ENS listing expiry in Unix seconds. Omitted for explicitly chosen, unlisted endpoints. */
  expiry?: number;
}

export type EndpointState = "eligible" | "cooldown" | "excluded" | "expired";
export type SelectionMode = "balanced" | "fastest" | "reliable";

/** The listing no longer authorizes new requests; renewal requires an explicit new selection. */
export function assertOperatorActive(endpoint: PoolEndpoint, now = Date.now()): void {
  if (endpoint.expiry !== undefined && (!Number.isSafeInteger(endpoint.expiry) || endpoint.expiry <= 0)) throw new Error("invalid operator listing expiry");
  if (endpoint.expiry !== undefined && endpoint.expiry <= now / 1000) throw new Error("operator listing expired; refresh the directory before reading");
}

export interface PoolEvent {
  type: "attempt" | "success" | "invalid-proof" | "transient-failure" | "stopped" | "exhausted";
  endpoint?: string;
  attempt?: number;
  detail?: string;
  at: number;
}

export interface PoolAttempt {
  endpoint: string;
  kind: "invalid-proof" | "transient-failure";
  error: string;
}

export class PoolExhaustedError extends Error {
  override name = "PoolExhaustedError";
  constructor(readonly attempts: PoolAttempt[]) {
    super(
      attempts.length === 0
        ? "no endpoint left: every chosen operator is excluded or expired"
        : `all ${attempts.length} attempts failed: ${attempts.map((a) => `${a.endpoint} (${a.kind})`).join(", ")}`,
    );
  }
}

/** Neither an explicit choice nor an authorized automatic pool supplied an operator. */
export class NoOperatorsChosenError extends Error {
  override name = "NoOperatorsChosenError";
  constructor() {
    super("no operators chosen: choose at least one operator before reading");
  }
}

export interface PoolOptions {
  endpoints: PoolEndpoint[];
  /** Explicit automatic selection; omitted preserves manual priority tiers and random ties. */
  selection?: SelectionMode;
  /**
   * Carry local observations and account affinity across a pool replacement. The caller must only
   * include ids whose complete authenticated identity (including signer) has not changed. The pool
   * additionally checks each id's URL, ENS name and operator label. No account data is exported.
   */
  preserveFrom?: { pool: Pool; ids: Iterable<string> };
  /** JSON-RPC to one endpoint, through the anonymous transport. */
  sendFor: (endpoint: PoolEndpoint) => JsonRpcSend;
  /** Optional per-logical-read lifecycle, e.g. credit reservation and post-verification payment. */
  prepareAttempt?: (context: PoolOperationContext, send: JsonRpcSend) => Promise<PoolAttemptLifecycle>;
  /** Provider shutdown or a replacement operator choice cancels every pending operation. */
  signal?: AbortSignal;
  /** Ids excluded earlier in this session (for example before the user changed their choice). */
  excluded?: Iterable<string>;
  /** Endpoints tried per read, one at a time. Default 3. */
  maxAttempts?: number;
  /** Time budget per read across attempts. Default 30 s. */
  totalTimeoutMs?: number;
  /** How long an endpoint rests after a transient failure. Default 60 s. */
  cooldownMs?: number;
  random?: () => number;
  now?: () => number;
  onEvent?: (event: PoolEvent) => void;
}

export interface Pool {
  /**
   * Run one read on one endpoint at a time; on failure, move to another chosen endpoint.
   * With `account`, reads for that account stay on the endpoint that last served it.
   * Once completion/signing starts, failures are terminal to avoid duplicate payment.
   */
  run<T>(operation: (send: JsonRpcSend, context: PoolOperationContext) => Promise<T>, opts?: PoolRunOptions): Promise<T>;
  /** Change ranking without moving accounts already assigned to an eligible operator. */
  setSelection(selection?: SelectionMode): void;
  status(): EndpointStatus[];
}

export interface PoolRunOptions {
  account?: string;
  kind?: "proof" | "code" | "call";
  /** Internal bootstrap/discovery work can explicitly bypass spending hooks. */
  paid?: boolean;
  /** False for unverified metadata calls: their outcome must not train verified-read selection. */
  observe?: boolean;
  signal?: AbortSignal;
  totalTimeoutMs?: number;
  /** Recheck pinned context before and after completion (including asynchronous voucher signing). */
  assertValid?: () => void;
}

export interface PoolOperationContext {
  endpoint: PoolEndpoint;
  signal: AbortSignal;
  kind: "proof" | "code" | "call";
  paid: boolean;
}

export interface PoolAttemptLifecycle {
  send: JsonRpcSend;
  /** Called after verification; once invoked, this operation will never retry on another endpoint. */
  verified?(): Promise<unknown>;
  failed?(error: unknown): void;
}

export interface EndpointStatus {
  id: string;
  url: string;
  priority: number;
  operator?: string;
  ens?: string;
  state: EndpointState;
  until?: number;
  /** Recent local completed attempts only; absence means unobserved, never healthy. */
  observations?: PoolObservations;
}

export interface PoolObservations {
  attempts: number;
  successes: number;
  failures: number;
  /** Mean time to a verified result, excluding payment completion. */
  meanVerifiedMs?: number;
  lastObservedAt: number;
}

interface Observation { at: number; success: boolean; verifiedMs?: number }
interface EndpointMemory { excluded: boolean; cooldownUntil: number; observations: Observation[] }
interface PoolMemory {
  endpoints: PoolEndpoint[];
  state: Map<string, EndpointMemory>;
  affinity: Map<string, string>;
}

const OBSERVATION_WINDOW_MS = 5 * 60_000;
const OBSERVATION_LIMIT = 32;
const EXPLORATION_RATE = 0.1;
const poolMemory = new WeakMap<Pool, PoolMemory>();
const idOf = (e: PoolEndpoint) => e.id ?? e.url;
let nextPoolId = 0;

/**
 * A client-side pool of the execution endpoints the user chose. All of its state stays on the device.
 * - An answer that fails proof verification excludes that endpoint locally for this session. That is
 *   local evidence only: the untrusted worker could also have altered the response.
 * - Timeouts, rate limits, Tor exit failures and RPC errors put the endpoint on a short cooldown.
 * - Retries use a fresh Tor circuit: an isolation key derived from the same account's key.
 * - Errors that aren't the endpoint's fault (stale header, worker pin, dead transport) are never retried.
 */
export function createPool(opts: PoolOptions): Pool {
  const poolId = ++nextPoolId;
  let nextRunId = 0;
  const endpoints = opts.endpoints.map(endpoint => ({ ...endpoint }));
  let selection = opts.selection;
  const maxAttempts = opts.maxAttempts ?? 3;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 30_000;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const emit = (e: Omit<PoolEvent, "at">) => {
    // Observers must not turn a verified, already-paid success into another retry.
    try { opts.onEvent?.({ ...e, at: now() }); } catch { /* app observer */ }
  };
  for (const [label, value] of Object.entries({ maxAttempts, totalTimeoutMs, cooldownMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  }
  for (const endpoint of endpoints) {
    if (endpoint.expiry !== undefined && (!Number.isSafeInteger(endpoint.expiry) || endpoint.expiry <= 0)) throw new Error("invalid operator listing expiry");
  }
  validateSelection(selection);
  const excludedBefore = new Set(opts.excluded ?? []);
  const state = new Map<string, EndpointMemory>(endpoints.map((e) => [idOf(e), { excluded: excludedBefore.has(idOf(e)), cooldownUntil: 0, observations: [] }]));
  // Keep each account on its assigned operator while eligible. Only failures or explicit removal
  // move it; changing ranking or exploration never spreads an established account's reads.
  const affinity = new Map<string, string>();
  const previous = opts.preserveFrom && poolMemory.get(opts.preserveFrom.pool);
  if (previous) {
    const allowed = new Set(opts.preserveFrom!.ids);
    const carried = new Set<string>();
    for (const endpoint of endpoints) {
      const id = idOf(endpoint), prior = previous.endpoints.find(e => idOf(e) === id);
      const memory = previous.state.get(id);
      if (!allowed.has(id) || !prior || !memory || prior.url !== endpoint.url || prior.ens !== endpoint.ens || prior.operator !== endpoint.operator) continue;
      state.set(id, { excluded: excludedBefore.has(id) || memory.excluded, cooldownUntil: memory.cooldownUntil, observations: memory.observations.map(sample => ({ ...sample })) });
      carried.add(id);
    }
    for (const [account, id] of previous.affinity) if (carried.has(id)) affinity.set(account, id);
  }

  function validateSelection(mode: SelectionMode | undefined): void {
    if (mode === undefined) return;
    if (!["balanced", "fastest", "reliable"].includes(mode)) throw new Error("invalid pool selection mode");
    const ids = new Set<string>(), names = new Set<string>(), urls = new Set<string>();
    for (const endpoint of endpoints) {
      const id = idOf(endpoint), name = endpoint.ens?.toLowerCase();
      if (ids.has(id) || urls.has(endpoint.url) || name && names.has(name)) throw new Error("automatic selection requires one endpoint per operator identity");
      ids.add(id); urls.add(endpoint.url); if (name) names.add(name);
    }
  }

  function observations(id: string): PoolObservations | undefined {
    const memory = state.get(id)!;
    const at = now();
    memory.observations = memory.observations.filter(sample => sample.at > at - OBSERVATION_WINDOW_MS && sample.at <= at);
    const samples = memory.observations;
    if (!samples.length) return undefined;
    const successes = samples.filter(sample => sample.success);
    return {
      attempts: samples.length, successes: successes.length, failures: samples.length - successes.length,
      ...(successes.length ? { meanVerifiedMs: successes.reduce((total, sample) => total + sample.verifiedMs!, 0) / successes.length } : {}),
      lastObservedAt: samples[samples.length - 1]!.at,
    };
  }

  function observe(id: string, success: boolean, verifiedMs?: number): void {
    if (success && (verifiedMs === undefined || !Number.isFinite(verifiedMs) || verifiedMs < 0)) return;
    observations(id); // discard stale samples before recording the bounded new observation
    const samples = state.get(id)!.observations;
    samples.push({ at: now(), success, ...(success ? { verifiedMs } : {}) });
    if (samples.length > OBSERVATION_LIMIT) samples.splice(0, samples.length - OBSERVATION_LIMIT);
  }

  const sample = <T,>(items: T[]): T => items[Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)))]!;

  function ranked(eligible: PoolEndpoint[]): PoolEndpoint {
    const measured = eligible.map(endpoint => ({ endpoint, observed: observations(idOf(endpoint)) }));
    // Exploration selects one operator for the actual read. It creates no probes or parallel copies.
    if (measured.every(item => !item.observed) || random() < EXPLORATION_RATE) return sample(eligible);
    const timings = measured.flatMap(item => item.observed?.meanVerifiedMs === undefined ? [] : [Math.max(1, item.observed.meanVerifiedMs)]).sort((a, b) => a - b);
    const referenceMs = timings[Math.floor(timings.length / 2)] ?? 1000;
    const scores = measured.map(({ endpoint, observed }) => {
      // One success and one failure as a prior: an unobserved endpoint is neutral, not healthy.
      const reliability = ((observed?.successes ?? 0) + 1) / ((observed?.attempts ?? 0) + 2);
      const latency = observed?.meanVerifiedMs;
      const score = selection === "fastest" ? (latency === undefined ? -Infinity : -latency)
        : selection === "reliable" ? reliability
        : reliability / (1 + Math.max(1, latency ?? referenceMs) / referenceMs);
      return { endpoint, score };
    });
    const best = Math.max(...scores.map(item => item.score));
    return sample(scores.filter(item => item.score === best).map(item => item.endpoint));
  }

  const stateOf = (id: string): EndpointState => {
    const s = state.get(id)!;
    if (s.excluded) return "excluded";
    const endpoint = endpoints.find(e => idOf(e) === id)!;
    if (endpoint.expiry !== undefined && endpoint.expiry <= now() / 1000) return "expired";
    return s.cooldownUntil > now() ? "cooldown" : "eligible";
  };

  function choose(tried: Set<string>, account?: string): PoolEndpoint | undefined {
    const assigned = account ? endpoints.find((e) => idOf(e) === affinity.get(account)) : undefined;
    if (assigned && !tried.has(idOf(assigned)) && stateOf(idOf(assigned)) === "eligible") return assigned;
    const eligible = endpoints.filter((e) => !tried.has(idOf(e)) && stateOf(idOf(e)) === "eligible");
    if (eligible.length === 0) return secondChance();
    if (selection) return ranked(eligible);
    const best = Math.min(...eligible.map((e) => e.priority));
    const tier = eligible.filter((e) => e.priority === best);
    return sample(tier);
  }

  /**
   * Nothing fresh is left: give an operator that isn't excluded another try, on a fresh circuit, the one
   * whose cooldown ends first. Users choose few operators, and Tor exit failures usually clear on a new
   * circuit (#14), so a single bad exit shouldn't bench an operator. Invalid proofs are never retried.
   */
  function secondChance(): PoolEndpoint | undefined {
    const candidates = endpoints.filter((e) => ["eligible", "cooldown"].includes(stateOf(idOf(e))));
    if (candidates.length === 0) return undefined;
    return candidates.reduce((best, e) => (state.get(idOf(e))!.cooldownUntil < state.get(idOf(best))!.cooldownUntil ? e : best));
  }

  const pool: Pool = {
    async run(operation, runOpts) {
      if (endpoints.length === 0) throw new NoOperatorsChosenError();
      const account = runOpts?.account?.toLowerCase();
      const runId = ++nextRunId;
      const start = now();
      const budget = runOpts?.totalTimeoutMs ?? totalTimeoutMs;
      if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("invalid pool time budget");
      const deadline = new AbortController();
      const timeout = setTimeout(() => deadline.abort(new Error("pool time budget exhausted")), budget);
      const signals = [deadline.signal, opts.signal, runOpts?.signal].filter((s): s is AbortSignal => !!s);
      const signal = AbortSignal.any(signals);
      const tried = new Set<string>();
      const attempts: PoolAttempt[] = [];
      try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        if (runOpts?.signal?.aborted) throw runOpts.signal.reason;
        if (deadline.signal.aborted || now() - start >= budget) break;
        const endpoint = choose(tried, account);
        if (!endpoint) break;
        const id = idOf(endpoint);
        const attemptStarted = now();
        // Reserve before any await: concurrent reads for this account use the same first operator.
        if (account) affinity.set(account, id);
        // A retry, or another try at an operator that failed before, goes out on a fresh circuit.
        const fresh = attempt > 1 || tried.has(id) || stateOf(id) !== "eligible";
        tried.add(id);
        emit({ type: "attempt", endpoint: id, attempt });

        let lifecycle: PoolAttemptLifecycle | undefined;
        let completionStarted = false;
        try {
          const context: PoolOperationContext = { endpoint, signal, kind: runOpts?.kind ?? "proof", paid: runOpts?.paid !== false };
          const base = opts.sendFor(endpoint);
          const send: JsonRpcSend = (method, params, requestOptions) => {
            signal.throwIfAborted();
            assertOperatorActive(endpoint, now());
            const requestSignal = requestOptions.signal ? AbortSignal.any([signal, requestOptions.signal]) : signal;
            return base(method, params, { ...requestOptions, signal: requestSignal, isolationKey: fresh ? `${requestOptions.isolationKey}#retry-${poolId}-${runId}-${attempt}` : requestOptions.isolationKey });
          };
          lifecycle = opts.prepareAttempt ? await withinSignal(opts.prepareAttempt(context, send).then(prepared => {
            if (signal.aborted) prepared.failed?.(signal.reason);
            return prepared;
          }), signal) : { send };
          const prepared = lifecycle!;
          const value = await withinSignal(operation(prepared.send, context), signal);
          signal.throwIfAborted();
          if (now() - start >= budget) throw new Error("pool time budget exhausted");
          if (state.get(id)!.excluded) throw new ProofVerificationError("operator was excluded while this read was in flight");
          assertOperatorActive(endpoint, now());
          runOpts?.assertValid?.();
          const verifiedMs = now() - attemptStarted;
          // Completion may create a spendable voucher even if it later rejects. From this point,
          // any refusal is terminal: never retry the operation and potentially pay a second time.
          completionStarted = true;
          await withinSignal(Promise.resolve(prepared.verified?.()), signal);
          signal.throwIfAborted();
          if (now() - start >= budget) throw new Error("pool time budget exhausted");
          assertOperatorActive(endpoint, now());
          runOpts?.assertValid?.();
          if (account && (!affinity.has(account) || affinity.get(account) === id)) affinity.set(account, id);
          state.get(id)!.cooldownUntil = 0; // it answered: no reason to keep it resting
          if (runOpts?.observe !== false) observe(id, true, verifiedMs);
          emit({ type: "success", endpoint: id, attempt });
          return value;
        } catch (error) {
          lifecycle?.failed?.(error);
          const detail = error instanceof Error ? error.message : String(error);
          if (opts.signal?.aborted || runOpts?.signal?.aborted) {
            emit({ type: "stopped", endpoint: id, attempt, detail });
            throw opts.signal?.aborted ? opts.signal.reason : runOpts!.signal!.reason;
          }
          if (completionStarted || isNotTheEndpointsFault(error)) {
            emit({ type: "stopped", endpoint: id, attempt, detail });
            throw error;
          }
          // A caller cancellation or local freshness/signing refusal says nothing about this
          // endpoint. Keep that account assigned; only a retryable endpoint failure moves it.
          if (account && affinity.get(account) === id) affinity.delete(account);
          if (error instanceof ProofVerificationError) {
            state.get(id)!.excluded = true;
            if (runOpts?.observe !== false) observe(id, false);
            attempts.push({ endpoint: id, kind: "invalid-proof", error: detail });
            emit({ type: "invalid-proof", endpoint: id, attempt, detail });
          } else {
            state.get(id)!.cooldownUntil = now() + cooldownMs;
            // Expiry is local authorization ending, not evidence of endpoint performance.
            if (runOpts?.observe !== false && stateOf(id) !== "expired") observe(id, false);
            attempts.push({ endpoint: id, kind: "transient-failure", error: detail });
            emit({ type: "transient-failure", endpoint: id, attempt, detail });
          }
        }
      }
      emit({ type: "exhausted" });
      throw new PoolExhaustedError(attempts);
      } finally { clearTimeout(timeout); }
    },
    setSelection(mode) { validateSelection(mode); selection = mode; },
    status() {
      return endpoints.map((e) => {
        const s = state.get(idOf(e))!;
        const current = stateOf(idOf(e));
        const observed = observations(idOf(e));
        return { id: idOf(e), url: e.url, priority: e.priority, operator: e.operator, ens: e.ens, state: current, ...(current === "cooldown" ? { until: s.cooldownUntil } : {}), ...(observed ? { observations: observed } : {}) };
      });
    },
  };
  poolMemory.set(pool, { endpoints, state, affinity });
  return pool;
}

/** Stop waiting even if an upstream implementation ignores cancellation; never accept its late result. */
function withinSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { promise.catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function isNotTheEndpointsFault(error: unknown): boolean {
  return (
    error instanceof Error && ["InputError", "ExecutionLimitError", "UnsupportedExecutionError", "CallRevertedError", "AbortError"].includes(error.name) ||
    error instanceof StaleHeaderError ||
    error instanceof StaleCheckpointError ||
    error instanceof HeaderSourceNotReadyError ||
    error instanceof WorkerPinMismatchError ||
    error instanceof WorkerPinChainError ||
    error instanceof TransportUnavailableError
  );
}
