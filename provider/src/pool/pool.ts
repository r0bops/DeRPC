import { HeaderSourceNotReadyError, StaleCheckpointError, StaleHeaderError } from "../light-client/header-source.ts";
import { TransportUnavailableError } from "../transport/anon-transport.ts";
import { ProofVerificationError } from "../verify/mpt.ts";
import type { JsonRpcSend } from "../verify/reader.ts";
import { WorkerPinChainError, WorkerPinMismatchError } from "../verify/worker-pin.ts";

export interface PoolEndpoint {
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
        ? "no eligible endpoint: every endpoint is excluded or cooling down"
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
  sendFor: (url: string) => JsonRpcSend;
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
  status(): { url: string; priority: number; operator?: string; ens?: string; state: EndpointState; until?: number }[];
}

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
  const state = new Map(opts.endpoints.map((e) => [e.url, { excluded: false, cooldownUntil: 0 }]));
  // Sticky per account: each account's reads stay with one operator, so the other operators never
  // learn about that account. Re-assigned only when its operator fails or is excluded.
  const affinity = new Map<string, string>();

  const stateOf = (url: string): EndpointState => {
    const s = state.get(url)!;
    if (s.excluded) return "excluded";
    return s.cooldownUntil > now() ? "cooldown" : "eligible";
  };

  function choose(tried: Set<string>, account?: string): PoolEndpoint | undefined {
    const assigned = account ? opts.endpoints.find((e) => e.url === affinity.get(account)) : undefined;
    if (assigned && !tried.has(assigned.url) && stateOf(assigned.url) === "eligible") return assigned;
    const eligible = opts.endpoints.filter((e) => !tried.has(e.url) && stateOf(e.url) === "eligible");
    if (eligible.length === 0) return undefined;
    const best = Math.min(...eligible.map((e) => e.priority));
    const tier = eligible.filter((e) => e.priority === best);
    return tier[Math.min(tier.length - 1, Math.floor(random() * tier.length))];
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
        tried.add(endpoint.url);
        emit({ type: "attempt", endpoint: endpoint.url, attempt });

        const base = opts.sendFor(endpoint.url);
        const send: JsonRpcSend = (method, params, { isolationKey }) =>
          base(method, params, { isolationKey: attempt === 1 ? isolationKey : `${isolationKey}#retry-${attempt}` });
        try {
          const value = await operation(send);
          if (account) affinity.set(account, endpoint.url);
          emit({ type: "success", endpoint: endpoint.url, attempt });
          return value;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (isNotTheEndpointsFault(error)) {
            emit({ type: "stopped", endpoint: endpoint.url, attempt, detail });
            throw error;
          }
          if (error instanceof ProofVerificationError) {
            state.get(endpoint.url)!.excluded = true;
            attempts.push({ endpoint: endpoint.url, kind: "invalid-proof", error: detail });
            emit({ type: "invalid-proof", endpoint: endpoint.url, attempt, detail });
          } else {
            state.get(endpoint.url)!.cooldownUntil = now() + cooldownMs;
            attempts.push({ endpoint: endpoint.url, kind: "transient-failure", error: detail });
            emit({ type: "transient-failure", endpoint: endpoint.url, attempt, detail });
          }
        }
      }
      emit({ type: "exhausted" });
      throw new PoolExhaustedError(attempts);
    },
    status() {
      return opts.endpoints.map((e) => {
        const s = state.get(e.url)!;
        const current = stateOf(e.url);
        return { url: e.url, priority: e.priority, operator: e.operator, ens: e.ens, state: current, ...(current === "cooldown" ? { until: s.cooldownUntil } : {}) };
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
