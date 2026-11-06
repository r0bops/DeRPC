import type { AnonTransport } from "./anon-transport.ts";
import { MAX_RESPONSE_BYTES, readResponseBody } from "./response-body.ts";

export interface FetchAdapterOptions {
  /** Requests under different keys should not be linkable (worker-dependent). */
  isolationKey: string;
  /** Bound for both the response headers and the response body. Default 60 s. */
  timeoutMs?: number;
  /** Refuse a response body larger than this. Default 16 MiB. */
  maxBodyBytes?: number;
  /** Personal-node credentials, selected by exact origin only. */
  headersForUrl?: (url: string) => Record<string, string>;
}

const DEFAULT_BODY_MS = 60_000;

/**
 * Present the anonymous transport as a standard fetch, for libraries that take one (the light
 * client's API client). Every call becomes a transport call; nothing reaches the network directly.
 */
export function asFetch(transport: AnonTransport, opts: FetchAdapterOptions): typeof fetch {
  const adapted = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : input instanceof URL ? input.href : String(input);
    const method = init.method ?? request?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init.headers ?? request?.headers).entries());
    const body = init.body !== undefined && init.body !== null ? await bodyOf(init.body) : request ? await requestBody(request) : undefined;
    const signal = init.signal ?? request?.signal ?? undefined;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_BODY_MS;
    const deadline = performance.now() + timeoutMs;
    const upstream = await transport.fetch(url, {
      method,
      headers: { ...headers, ...opts.headersForUrl?.(url) },
      redirect: "error",
      body,
      signal,
      isolationKey: opts.isolationKey,
      timeoutMs,
    });
    // The transport's timeout covers the headers; a stuck or unbounded body would stop the light
    // client's polling loop forever (#28). Read it here under the same deadline.
    const bytes = await readResponseBody(upstream, {
      timeoutMs: deadline - performance.now(),
      maxBytes: opts.maxBodyBytes ?? MAX_RESPONSE_BYTES,
      signal,
    });
    return new Response(bytes.byteLength > 0 ? bytes : null, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
  };
  return adapted as typeof fetch;
}

async function bodyOf(body: BodyInit): Promise<string | Uint8Array> {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function requestBody(request: Request): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const text = await request.text();
  return text.length > 0 ? text : undefined;
}
