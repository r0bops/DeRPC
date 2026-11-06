import type { AnonTransport } from "./anon-transport.ts";

export interface FetchAdapterOptions {
  /** Requests under different keys should not be linkable (worker-dependent). */
  isolationKey: string;
  /** Bound for both the response headers and the response body. Default 60 s. */
  timeoutMs?: number;
  /** Refuse a response body larger than this. Default 16 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_BODY_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

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
    const upstream = await transport.fetch(url, {
      method,
      headers,
      body,
      signal,
      isolationKey: opts.isolationKey,
      timeoutMs: opts.timeoutMs,
    });
    // The transport's timeout covers the headers; a stuck or unbounded body would stop the light
    // client's polling loop forever (#28). Read it here under the same deadline.
    const bytes = await readBody(upstream, opts.timeoutMs ?? DEFAULT_BODY_MS, signal, opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    return new Response(bytes.byteLength > 0 ? bytes : null, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
  };
  return adapted as typeof fetch;
}

async function readBody(res: Response, timeoutMs: number, signal: AbortSignal | undefined, maxBytes: number): Promise<ArrayBuffer> {
  if (!res.body) return new ArrayBuffer(0);
  if (signal?.aborted) throw abortReason(signal);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new Error(`response body did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        void reader.cancel().catch(() => {});
        reject(abortReason(signal));
      },
      { once: true },
    );
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline, aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error(`response body exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const body = new ArrayBuffer(total);
  const view = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("request aborted");
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
