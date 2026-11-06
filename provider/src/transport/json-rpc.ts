import type { JsonRpcSend } from "../verify/reader.ts";
import type { AnonTransport } from "./anon-transport.ts";
import { MAX_RESPONSE_BYTES, readResponseBody } from "./response-body.ts";

/** JSON-RPC to one execution endpoint, always through the anonymous transport. */
export function createJsonRpcSend(transport: AnonTransport, endpoint: string, opts: { timeoutMs?: number; maxBodyBytes?: number; headers?: Record<string, string> | (() => Record<string, string>) } = {}): JsonRpcSend {
  let nextId = 1;
  return async (method, params, { isolationKey, signal, headers }) => {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const deadline = performance.now() + timeoutMs;
    const id = nextId++;
    const res = await transport.fetch(endpoint, {
      method: "POST",
      headers: { ...(typeof opts.headers === "function" ? opts.headers() : opts.headers), ...headers, "content-type": "application/json" },
      redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      isolationKey,
      timeoutMs,
      signal,
    });
    // The worker's timeout only covers the response headers: bound the body too, or a stuck body
    // hangs the read past the pool's budget (#28).
    const bytes = await readResponseBody(res, {
      timeoutMs: deadline - performance.now(),
      maxBytes: opts.maxBodyBytes ?? MAX_RESPONSE_BYTES,
      signal,
    });
    const text = new TextDecoder().decode(bytes);
    if (!res.ok) throw new Error(`${new URL(endpoint).host} answered HTTP ${res.status}: ${text.slice(0, 120)}`);
    let json: { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${new URL(endpoint).host} returned non-JSON: ${text.slice(0, 80)}`);
    }
    if (!json || typeof json !== "object" || Array.isArray(json) || json.jsonrpc !== "2.0" || json.id !== id || ("result" in json) === ("error" in json)) {
      throw new Error(`${new URL(endpoint).host} returned an invalid JSON-RPC envelope`);
    }
    if (json.error) throw new Error(`${new URL(endpoint).host}: ${json.error.message ?? "JSON-RPC error"} (${json.error.code ?? "?"})`);
    return json.result;
  };
}
