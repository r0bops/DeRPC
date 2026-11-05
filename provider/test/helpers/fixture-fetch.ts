// Test utility: a fetch that serves recorded beacon responses by path and remembers what was asked.
export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  encoding?: "utf8" | "base64";
  body: string;
}

export interface FixtureFetch {
  fetch: typeof fetch;
  /** Paths requested so far, in order, e.g. "/eth/v1/beacon/light_client/optimistic_update". */
  requested: string[];
}

export function fixtureFetch(baseUrl: string, responses: Record<string, RecordedResponse>): FixtureFetch {
  const requested: string[] = [];
  const fn = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(baseUrl)) throw new Error(`fixture fetch: unexpected host in ${url}`);
    const path = url.slice(baseUrl.length);
    requested.push(path);
    const recorded = responses[path];
    if (!recorded) return new Response(JSON.stringify({ code: 404, message: `no fixture for ${path}` }), { status: 404 });
    const body = recorded.encoding === "base64" ? Buffer.from(recorded.body, "base64") : recorded.body;
    return new Response(body, { status: recorded.status, headers: recorded.headers });
  };
  return { fetch: fn as typeof fetch, requested };
}
