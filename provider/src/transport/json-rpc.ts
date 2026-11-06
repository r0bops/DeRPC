import type { JsonRpcSend } from "../verify/reader.ts";
import type { AnonTransport } from "./anon-transport.ts";

/** JSON-RPC to one execution endpoint, always through the anonymous transport. */
export function createJsonRpcSend(transport: AnonTransport, endpoint: string, opts: { timeoutMs?: number } = {}): JsonRpcSend {
  let nextId = 1;
  return async (method, params, { isolationKey, signal }) => {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const res = await transport.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      isolationKey,
      timeoutMs,
      signal,
    });
    // The worker's timeout only covers the response headers: bound the body too, or a stuck body
    // hangs the read past the pool's budget (#28).
    const text = await readBody(res, timeoutMs, signal);
    if (!res.ok) throw new Error(`${new URL(endpoint).host} answered HTTP ${res.status}: ${text.slice(0, 120)}`);
    let json: { result?: unknown; error?: { code?: number; message?: string } };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${new URL(endpoint).host} returned non-JSON: ${text.slice(0, 80)}`);
    }
    if (json.error) throw new Error(`${new URL(endpoint).host}: ${json.error.message ?? "JSON-RPC error"} (${json.error.code ?? "?"})`);
    return json.result;
  };
}

async function readBody(res: Response, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortReason(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    void res.body?.cancel().catch(() => {});
    rejectAbort(abortReason(signal!));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void res.body?.cancel().catch(() => {});
      reject(new Error(`response body did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([res.text(), deadline, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("request aborted");
}
