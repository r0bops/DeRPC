// Optional server-side fault overlay for an explicitly configured, free demo proxy.
// It never changes the underlying wrapper or its cache and exposes no public mutation route.
export const DEMO_ACCOUNT = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const MAX_BODY = 64 * 1024, MAX_RESPONSE = 4 * 1024 * 1024;
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers,
} });

async function boundedBytes(body, limit, signal) {
  const reader = body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0; const chunks = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { cancel(); throw new Error('Body limit exceeded'); }
      chunks.push(value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export async function assertDemoUpstream(upstream, ens, fetcher = fetch) {
  if (upstream !== 'http://127.0.0.1:8787' || !/^demo-[23]\.derpc\.eth$/.test(ens)) throw new Error('Only the two designated loopback demo proxies may use this overlay');
  const signal = AbortSignal.timeout(5000);
  const response = await fetcher(`${upstream}/.well-known/derpc.json`, { signal, redirect: 'error' });
  const identity = JSON.parse(new TextDecoder().decode(await boundedBytes(response.body, 4096, signal)));
  if (!response.ok || identity.ens !== ens || identity.service !== 'demo-proxy' || identity.version !== '1' || !identity.chains?.includes(1)) throw new Error('Upstream is not the expected mainnet demo proxy');
  return identity;
}

export function createDemoHandler({ state, fetcher = fetch, upstream = 'http://127.0.0.1:8787' }) {
  if (upstream !== 'http://127.0.0.1:8787') throw new Error('Demo overlay requires the fixed loopback wrapper');
  return async request => {
    const url = new URL(request.url);
    const current = state();
    if (request.method === 'GET' && url.pathname === '/.well-known/derpc-demo.json' && !url.search) return json({
      demoOnly: true, ...current, corruptionAccount: DEMO_ACCOUNT, control: 'operator SSH only',
    });
    if (!['GET', 'POST'].includes(request.method) || url.pathname.startsWith('//')) return json({ error: 'Route is not allowed' }, 404);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
    try {
      const body = request.method === 'POST' ? await boundedBytes(request.body, MAX_BODY, signal) : undefined;
      const rpc = request.method === 'POST' && url.pathname === '/rpc' && !url.search;
      if (rpc && current.mode === 'unavailable' && state().id === current.id) return json({
        error: 'Deliberate demo RPC outage', demoOnly: true, expiresAt: current.expiresAt,
      }, 503, { 'x-derpc-demo-scenario': 'unavailable' });
      const response = await fetcher(upstream + url.pathname + url.search, {
        method: request.method, headers: { 'content-type': request.headers.get('content-type') ?? '' },
        ...(body ? { body } : {}), redirect: 'error', signal,
      });
      let bytes = await boundedBytes(response.body, MAX_RESPONSE, signal);
      let changed = false;
      if (rpc && response.ok && current.mode === 'corrupt-proof' && state().id === current.id) {
        // Only the public WETH demonstration account is corrupted. Worker-pin/ENS proofs stay intact.
        const calls = JSON.parse(new TextDecoder().decode(body));
        const result = JSON.parse(new TextDecoder().decode(bytes));
        const entries = Array.isArray(calls) ? calls : [calls];
        const replies = Array.isArray(result) ? result : [result];
        for (const call of entries) {
          if (call?.method !== 'eth_getProof' || typeof call.params?.[0] !== 'string' || call.params[0].toLowerCase() !== DEMO_ACCOUNT) continue;
          const reply = replies.find(reply => reply?.id === call.id);
          const balance = reply?.result?.balance;
          if (typeof balance !== 'string' || !/^0x(?:0|[1-9a-fA-F][\da-fA-F]{0,63})$/.test(balance)) continue;
          reply.result.balance = `0x${(BigInt(balance) ^ 1n).toString(16)}`;
          changed = true;
        }
        if (changed) bytes = new TextEncoder().encode(JSON.stringify(result));
      }
      return new Response(bytes, { status: response.status, headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', ...(changed ? { 'x-derpc-demo-scenario': 'corrupt-proof' } : {}),
      } });
    } catch {
      return json({ error: signal.aborted ? 'Demo proxy deadline exceeded' : 'Demo proxy upstream request failed' }, signal.aborted ? 504 : 502);
    }
  };
}
