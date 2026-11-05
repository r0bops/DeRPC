import type { AnonTransport } from "./anon-transport.ts";

export interface FetchAdapterOptions {
  /** Requests under different keys should not be linkable (worker-dependent). */
  isolationKey: string;
  timeoutMs?: number;
}

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
    return transport.fetch(url, {
      method,
      headers,
      body,
      signal: init.signal ?? request?.signal ?? undefined,
      isolationKey: opts.isolationKey,
      timeoutMs: opts.timeoutMs,
    });
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
