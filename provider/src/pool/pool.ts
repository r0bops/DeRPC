import { HeaderSourceNotReadyError, StaleCheckpointError, StaleHeaderError } from "../light-client/header-source.ts";
import { TransportUnavailableError } from "../transport/anon-transport.ts";
import { ProofVerificationError } from "../verify/mpt.ts";
import type { JsonRpcSend } from "../verify/reader.ts";
import { WorkerPinChainError, WorkerPinMismatchError } from "../verify/worker-pin.ts";

export interface PoolEndpoint {
  /** Tells apart entries that share a URL (the simulated lying operator wraps a real one). Defaults to `url`. */
  id?: string;
  url: string;
  /** Lower is preferred. The pool only uses a higher tier when no lower tier is eligible. */
  priority: number;
  /** Who runs it, where known. Several URLs don't prove independent operators. */
  operator?: string;
  /** The operator's ENS name (mock until the ENS milestone). */
  ens?: string;
}

export type EndpointState = "eligible" | "cooldown" | "excluded";

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
        ? "no endpoint left: every chosen operator is excluded after an invalid proof"
        : `all ${attempts.length} attempts failed: ${attempts.map((a) => `${a.endpoint} (${a.kind})`).join(", ")}`,
    );
  }
}

/** The user hasn't chosen any operator. DeRPC never picks operators on the user's behalf. */
export class NoOperatorsChosenError extends Error {
  override name = "NoOperatorsChosenError";
  constructor() {
    super("no operators chosen: choose at least one operator before reading");
  }
}

export interface PoolOptions {
  endpoints: PoolEndpoint[];
  /** JSON-RPC to one endpoint, through the anonymous transport. */
  sendFor: (endpoint: PoolEndpoint) => JsonRpcSend;
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
   */
  run<T>(operation: (send: JsonRpcSend) => Promise<T>, opts?: { account?: string }): Promise<T>;
  status(): EndpointStatus[];
}

export interface EndpointStatus {
  id: string;
  url: string;
  priority: number;
  operator?: string;
  ens?: string;
  state: EndpointState;
  until?: number;
}

const idOf = (e: PoolEndpoint) => e.id ?? e.url;

/**
 * A client-side pool of the execution endpoints the user chose. All of its state stays on the device.
 * - An answer that fails proof verification excludes that endpoint locally for this session. That is
 *   local evidence only: the untrusted worker could also have altered the response.
 * - Timeouts, rate limits, Tor exit failures and RPC errors put the endpoint on a short cooldown.
 * - Retries use a fresh Tor circuit: an isolation key derived from the same account's key.
 * - Errors that aren't the endpoint's fault (stale header, worker pin, dead transport) are never retried.
 */
export function createPool(opts: PoolOptions): Pool {
  const maxAttempts = opts.maxAttempts ?? 3;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 30_000;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const emit = (e: Omit<PoolEvent, "at">) => opts.onEvent?.({ ...e, at: now() });
  const excludedBefore = new Set(opts.excluded ?? []);
  const state = new Map(opts.endpoints.map((e) => [idOf(e), { excluded: excludedBefore.has(idOf(e)), cooldownUntil: 0 }]));
  // Sticky per account: each account's reads stay with one operator, so the other operators never
  // learn about that account. Re-assigned only when its operator fails or is excluded.
  const affinity = new Map<string, string>();

  const stateOf = (id: string): EndpointState => {
    const s = state.get(id)!;
    if (s.excluded) return "excluded";
    return s.cooldownUntil > now() ? "cooldown" : "eligible";
  };

  function choose(tried: Set<string>, account?: string): PoolEndpoint | undefined {
    const assigned = account ? opts.endpoints.find((e) => idOf(e) === affinity.get(account)) : undefined;
    if (assigned && !tried.has(idOf(assigned)) && stateOf(idOf(assigned)) === "eligible") return assigned;
    const eligible = opts.endpoints.filter((e) => !tried.has(idOf(e)) && stateOf(idOf(e)) === "eligible");
    if (eligible.length === 0) return secondChance();
    const best = Math.min(...eligible.map((e) => e.priority));
    const tier = eligible.filter((e) => e.priority === best);
    return tier[Math.min(tier.length - 1, Math.floor(random() * tier.length))];
  }

  /**
   * Nothing fresh is left: give an operator that isn't excluded another try, on a fresh circuit, the one
   * whose cooldown ends first. Users choose few operators, and Tor exit failures usually clear on a new
   * circuit (#14), so a single bad exit shouldn't bench an operator. Invalid proofs are never retried.
   */
  function secondChance(): PoolEndpoint | undefined {
    const candidates = opts.endpoints.filter((e) => stateOf(idOf(e)) !== "excluded");
    if (candidates.length === 0) return undefined;
    return candidates.reduce((best, e) => (state.get(idOf(e))!.cooldownUntil < state.get(idOf(best))!.cooldownUntil ? e : best));
  }

  return {
    async run(operation, runOpts) {
      if (opts.endpoints.length === 0) throw new NoOperatorsChosenError();
      const account = runOpts?.account?.toLowerCase();
      const start = now();
      const tried = new Set<string>();
      const attempts: PoolAttempt[] = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1 && now() - start >= totalTimeoutMs) break;
        const endpoint = choose(tried, account);
        if (!endpoint) break;
        const id = idOf(endpoint);
        // A retry, or another try at an operator that failed before, goes out on a fresh circuit.
        const fresh = attempt > 1 || tried.has(id) || stateOf(id) !== "eligible";
        tried.add(id);
        emit({ type: "attempt", endpoint: id, attempt });

        const base = opts.sendFor(endpoint);
        const send: JsonRpcSend = (method, params, { isolationKey }) =>
          base(method, params, { isolationKey: fresh ? `${isolationKey}#retry-${attempt}` : isolationKey });
        try {
          const value = await operation(send);
          if (account) affinity.set(account, id);
          state.get(id)!.cooldownUntil = 0; // it answered: no reason to keep it resting
          emit({ type: "success", endpoint: id, attempt });
          return value;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (isNotTheEndpointsFault(error)) {
            emit({ type: "stopped", endpoint: id, attempt, detail });
            throw error;
          }
          if (error instanceof ProofVerificationError) {
            state.get(id)!.excluded = true;
            attempts.push({ endpoint: id, kind: "invalid-proof", error: detail });
            emit({ type: "invalid-proof", endpoint: id, attempt, detail });
          } else {
            state.get(id)!.cooldownUntil = now() + cooldownMs;
            attempts.push({ endpoint: id, kind: "transient-failure", error: detail });
            emit({ type: "transient-failure", endpoint: id, attempt, detail });
          }
        }
      }
      emit({ type: "exhausted" });
      throw new PoolExhaustedError(attempts);
    },
    status() {
      return opts.endpoints.map((e) => {
        const s = state.get(idOf(e))!;
        const current = stateOf(idOf(e));
        return { id: idOf(e), url: e.url, priority: e.priority, operator: e.operator, ens: e.ens, state: current, ...(current === "cooldown" ? { until: s.cooldownUntil } : {}) };
      });
    },
  };
}

function isNotTheEndpointsFault(error: unknown): boolean {
  return (
    error instanceof StaleHeaderError ||
    error instanceof StaleCheckpointError ||
    error instanceof HeaderSourceNotReadyError ||
    error instanceof WorkerPinMismatchError ||
    error instanceof WorkerPinChainError ||
    error instanceof TransportUnavailableError
  );
}
