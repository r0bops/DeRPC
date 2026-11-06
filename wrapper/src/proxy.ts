import { PaymentError, type PaymentRpc, type PaymentStatus } from "./payment.ts";

/** Operator-side filtering only. Clients must still verify every supported answer. */
export interface Identity {
  ens: string;
  signer: string;
  chains: number[];
  version: "1";
  service: "node" | "demo-proxy";
}

export interface ProxyOptions {
  executionUrl: string;
  beaconUrl: string;
  identity: Identity;
  /** Set only on the separate, unpublished personal listener. */
  personalToken?: string;
  fetch?: typeof fetch;
  limits?: Partial<typeof DEFAULT_LIMITS>;
  payments?: {
    admit(headers: Headers, calls: readonly PaymentRpc[], signal?: AbortSignal): Promise<void>;
    voucher(body: unknown, signal?: AbortSignal): Promise<PaymentStatus>;
  };
}

export const DEFAULT_LIMITS = {
  bodyBytes: 64 * 1024,
  responseBytes: 4 * 1024 * 1024,
  batch: 8,
  storageKeys: 32,
  timeoutMs: 15_000,
  executionConcurrency: 8,
  beaconConcurrency: 4,
  beaconBytes: 2 * 1024 * 1024,
  beaconUpdates: 4,
  cacheEntries: 128,
  cacheBytes: 16 * 1024 * 1024,
};

type Rpc = { jsonrpc: "2.0"; id: string | number; method: string; params: unknown[] };
const address = /^0x[\da-fA-F]{40}$/;
const quantity = /^0x(?:0|[1-9a-fA-F][\da-fA-F]*)$/;
const slot = /^0x[\da-fA-F]{1,64}$/;

class Rejection extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function createProxy(options: ProxyOptions): (request: Request) => Promise<Response> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const n of Object.values(limits)) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("limits must be positive integers");
  }
  for (const target of [options.executionUrl, options.beaconUrl]) {
    const url = new URL(target);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("invalid upstream URL");
  }
  if (options.personalToken !== undefined && !/^[a-f0-9]{64}$/.test(options.personalToken)) {
    throw new Error("personal token must be 32 random bytes encoded as lowercase hex");
  }
  if (options.personalToken && options.payments) throw new Error("personal mode never requires payment");
  const fetchUpstream = options.fetch ?? fetch;
  // Every listener owns its own cache and concurrency counters, including personal mode.
  const cache = new Map<string, { result: unknown; size: number }>();
  let cacheBytes = 0;
  let executionActive = 0;
  let beaconActive = 0;
  let nextId = 1;

  function validate(value: unknown): Rpc {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Rejection(400, "invalid JSON-RPC request");
    const r = value as Rpc;
    if (r.jsonrpc !== "2.0" || !(typeof r.id === "string" && r.id.length <= 128 || Number.isSafeInteger(r.id)) || !Array.isArray(r.params)) {
      throw new Rejection(400, "JSON-RPC 2.0, a bounded id and params array are required");
    }
    if (r.method === "eth_chainId") {
      if (r.params.length !== 0) throw new Rejection(400, "eth_chainId takes no parameters");
      return r;
    }
    if (!["eth_getProof", "eth_getCode"].includes(r.method)) throw new Rejection(403, "method is not allowed");
    const proof = r.method === "eth_getProof";
    if (r.params.length !== (proof ? 3 : 2) || typeof r.params[0] !== "string" || !address.test(r.params[0])) throw new Rejection(400, "invalid account parameters");
    const tag = r.params[proof ? 2 : 1];
    if (typeof tag !== "string" || !(tag === "finalized" || quantity.test(tag) && tag.length <= 66)) throw new Rejection(400, "use finalized or an explicit block number");
    if (proof) {
      const keys = r.params[1];
      if (!Array.isArray(keys) || keys.length > limits.storageKeys || keys.some(k => typeof k !== "string" || !slot.test(k))) throw new Rejection(400, "invalid or excessive storage keys");
    }
    return { jsonrpc: "2.0", id: r.id, method: r.method, params: r.params };
  }

  async function upstreamRpc(method: string, params: unknown[], signal: AbortSignal): Promise<{ result?: unknown; error?: unknown }> {
    const id = nextId++;
    const response = await fetchUpstream(options.executionUrl, {
      method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await boundedText(response, limits.responseBytes, signal);
    if (!response.ok) throw new Rejection(502, "execution upstream failed");
    const data = JSON.parse(text);
    if (!data || data.jsonrpc !== "2.0" || data.id !== id || ("result" in data) === ("error" in data)) throw new Rejection(502, "invalid upstream envelope");
    return data;
  }

  function remember(key: string, result: unknown) {
    const size = new TextEncoder().encode(JSON.stringify(result)).length;
    if (size > limits.cacheBytes) return;
    const previous = cache.get(key);
    if (previous) { cacheBytes -= previous.size; cache.delete(key); }
    while (cache.size && (cache.size >= limits.cacheEntries || cacheBytes + size > limits.cacheBytes)) {
      const first = cache.keys().next().value!;
      cacheBytes -= cache.get(first)!.size;
      cache.delete(first);
    }
    cache.set(key, { result, size });
    cacheBytes += size;
  }

  async function execution(request: Request, signal: AbortSignal): Promise<Response> {
    if (executionActive >= limits.executionConcurrency) throw new Rejection(429, "execution concurrency limit");
    executionActive++;
    try {
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new Rejection(415, "expected application/json");
      const text = await boundedText(request, limits.bodyBytes, signal);
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new Rejection(400, "invalid JSON"); }
      const batch = Array.isArray(body);
      const entries = batch ? body as unknown[] : [body];
      if (!entries.length || entries.length > limits.batch) throw new Rejection(400, "invalid batch size");
      // Validate the WHOLE batch before any request reaches the node.
      const calls = entries.map(validate);
      const ids = calls.map(r => `${typeof r.id}:${r.id}`);
      if (new Set(ids).size !== ids.length) throw new Rejection(400, "duplicate batch ids");
      if (options.payments) await withinDeadline(options.payments.admit(request.headers, calls, signal), signal);
      signal.throwIfAborted();
      // The node's own finalized block decides cache eligibility. This is not client verification.
      let finalized: bigint | undefined;
      if (calls.some(c => c.method !== "eth_chainId")) {
        const block = await upstreamRpc("eth_getBlockByNumber", ["finalized", false], signal);
        const number = (block.result as { number?: unknown } | null)?.number;
        if (typeof number !== "string" || !quantity.test(number)) throw new Rejection(502, "node has no finalized block");
        finalized = BigInt(number);
      }
      const replies = [];
      let replyBytes = 0;
      for (const call of calls) {
        const params = [...call.params];
        const tagIndex = call.method === "eth_getProof" ? 2 : 1;
        let key: string | undefined;
        if (call.method !== "eth_chainId") {
          if (params[tagIndex] === "finalized") params[tagIndex] = `0x${finalized!.toString(16)}`;
          if (BigInt(params[tagIndex] as string) > finalized!) throw new Rejection(400, "block is not finalized");
          key = JSON.stringify([call.method, params]).toLowerCase();
        }
        const hit = key ? cache.get(key) : undefined;
        const result = hit ? { result: hit.result } : await upstreamRpc(call.method, params, signal);
        if (!hit && key && result.result !== undefined && result.result !== null) remember(key, result.result);
        const reply = { jsonrpc: "2.0", id: call.id, ...("error" in result ? { error: result.error } : { result: result.result }) };
        replyBytes += new TextEncoder().encode(JSON.stringify(reply)).length + 1;
        if (replyBytes + 2 > limits.responseBytes) throw new Rejection(502, "batch response exceeds limit");
        replies.push(reply);
      }
      return json(batch ? replies : replies[0]);
    } finally { executionActive--; }
  }

  async function beacon(path: string, signal: AbortSignal): Promise<Response> {
    if (beaconActive >= limits.beaconConcurrency) throw new Rejection(429, "beacon concurrency limit");
    const url = new URL(path, "http://wrapper");
    const base = "/eth/v1/beacon/light_client/";
    const fixed = [base + "finality_update", base + "optimistic_update"];
    if (url.pathname === base + "updates") {
      const params = [...url.searchParams];
      if (params.length !== 2 || new Set(params.map(([k]) => k)).size !== 2 || !params.every(([k, v]) => ["start_period", "count"].includes(k) && /^(0|[1-9]\d{0,9})$/.test(v))) throw new Rejection(400, "invalid update query");
      const count = Number(url.searchParams.get("count"));
      if (count < 1 || count > limits.beaconUpdates) throw new Rejection(400, "too many updates");
    } else if (!(fixed.includes(url.pathname) || new RegExp(`^${base}bootstrap/0x[\\da-fA-F]{64}$`).test(url.pathname)) || url.search) {
      throw new Rejection(404, "beacon route is not allowed");
    }
    beaconActive++;
    try {
      const target = options.beaconUrl.replace(/\/$/, "") + path;
      const response = await fetchUpstream(target, { redirect: "error", signal, headers: { accept: "application/json" } });
      const text = await boundedText(response, limits.beaconBytes, signal);
      if (!response.ok) throw new Rejection(502, "beacon upstream failed");
      JSON.parse(text);
      return new Response(text, { headers: responseHeaders });
    } finally { beaconActive--; }
  }

  return async request => {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(limits.timeoutMs)]);
    try {
      if (options.personalToken && !equalToken(request.headers.get("authorization") ?? "", `Bearer ${options.personalToken}`)) throw new Rejection(401, "personal token required");
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/.well-known/derpc.json" && !url.search && !options.personalToken) return json(options.identity);
      if (request.method === "POST" && url.pathname === "/rpc" && !url.search) return await execution(request, signal);
      if (request.method === "POST" && url.pathname === "/payments/voucher" && !url.search && options.payments) {
        if (executionActive >= limits.executionConcurrency) throw new Rejection(429, "execution concurrency limit");
        executionActive++;
        try {
          if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new Rejection(415, "expected application/json");
          let body: unknown;
          try { body = JSON.parse(await boundedText(request, 4096, signal)); }
          catch (error) { if (error instanceof Rejection) throw error; throw new Rejection(400, "invalid payment JSON"); }
          return json(await withinDeadline(options.payments.voucher(body, signal), signal));
        } finally { executionActive--; }
      }
      if (request.method === "GET" && url.pathname.startsWith("/eth/")) return await beacon(url.pathname + url.search, signal);
      throw new Rejection(404, "route is not allowed");
    } catch (error) {
      const status = signal.aborted ? 504 : error instanceof Rejection || error instanceof PaymentError ? error.status : 502;
      return json({ error: error instanceof Rejection || error instanceof PaymentError ? error.message : signal.aborted ? "request deadline exceeded" : "upstream request failed" }, status);
    }
  };
}

const responseHeaders = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: responseHeaders }); }

/** Submission already journaled by the payment controller may finish after a timed-out caller. */
async function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation, deadline]); }
  finally { signal.removeEventListener("abort", abort); }
}

// Fixed-length comparison without prefix-dependent early exits. Tokens never enter upstream headers.
function equalToken(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) difference |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function boundedText(source: Request | Response, maximum: number, signal: AbortSignal): Promise<string> {
  if (Number(source.headers.get("content-length")) > maximum) throw new Rejection(413, "body exceeds limit");
  const reader = source.body?.getReader();
  if (!reader) return "";
  let used = 0;
  const chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      used += value.length;
      if (used > maximum) throw new Rejection(413, "body exceeds limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(used);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
