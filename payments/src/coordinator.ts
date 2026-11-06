import { createServer, type Server } from "node:http";
import type { Address, Hex } from "viem";
import type { CappedDelegationSigner, DelegatedRead } from "./delegation.ts";
import type { SponsoredPaymentCoordinator, SponsoredReadIntent } from "./sponsored.ts";

export interface CoordinatorServerOptions {
  port?: number;
  maxBodyBytes?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
}

/**
 * A loopback app-signing service. Only signed delegated approvals are exposed; grant/revoke stay
 * in the trusted application's administration code. No direct RPC client or verifier fallback.
 */
export function serveDelegationCoordinator(coordinator: CappedDelegationSigner, options: CoordinatorServerOptions = {}): Promise<Server> {
  return serveCoordinator(coordinator, options, false);
}

/** Complete sponsored flow; administration and closing are never exposed to delegated callers. */
export function serveSponsoredCoordinator(coordinator: SponsoredPaymentCoordinator, options: CoordinatorServerOptions = {}): Promise<Server> {
  return serveCoordinator(coordinator, options, true);
}

async function serveCoordinator(coordinator: CappedDelegationSigner | SponsoredPaymentCoordinator, options: CoordinatorServerOptions, sponsored: boolean): Promise<Server> {
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const maxConcurrent = options.maxConcurrent ?? 4;
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (![maxBodyBytes, maxConcurrent, timeoutMs].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid coordinator limits");
  let active = 0;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: timeoutMs, headersTimeout: Math.min(timeoutMs, 10000) }, async (req, res) => {
    const reply = (status: number, body: unknown) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value));
    };
    if (req.method !== "POST" || !(sponsored ? ["/authorize", "/complete"] : ["/approve"]).includes(req.url ?? "")) { reply(404, { error: "route not found" }); req.resume(); return; }
    if (active >= maxConcurrent) { reply(429, { error: "coordinator concurrency limit" }); req.resume(); return; }
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) { reply(415, { error: "expected application/json" }); req.resume(); return; }
    active++;
    const abort = new AbortController();
    const timeout = setTimeout(() => { abort.abort(new Error("coordinator deadline exceeded")); reply(504, { error: "coordinator deadline exceeded" }); req.destroy(); }, timeoutMs);
    req.on("aborted", () => abort.abort(new Error("client disconnected")));
    res.on("close", () => { if (!res.writableEnded) abort.abort(new Error("client disconnected")); });
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        abort.signal.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > maxBodyBytes) { reply(413, { error: "approval body too large" }); req.destroy(); return; }
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { request?: unknown; intent?: unknown; signature?: unknown; evidence?: unknown };
      if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) throw new Error("invalid delegated signature");
      let result: unknown;
      if (sponsored) {
        const intent = parseIntent(body.intent);
        const service = coordinator as SponsoredPaymentCoordinator;
        result = req.url === "/authorize"
          ? { authorization: await service.authorize(intent, body.signature as Hex, { signal: abort.signal }) }
          : { voucher: await service.complete(intent, body.signature as Hex, body.evidence, { signal: abort.signal }) };
      } else {
        result = { voucher: await (coordinator as CappedDelegationSigner).approve(parseDelegatedRead(body.request), body.signature as Hex, body.evidence, { signal: abort.signal }) };
      }
      abort.signal.throwIfAborted();
      reply(200, result);
    } catch (error) {
      reply(abort.signal.aborted ? 504 : 400, { error: error instanceof Error ? error.message : "approval failed" });
    } finally { clearTimeout(timeout); active--; }
  });
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server;
}

function parseIntent(value: unknown): SponsoredReadIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("missing sponsored intent");
  const input = value as Record<string, unknown>;
  const read = parseDelegatedRead({ ...input, readHash: input.requestHash });
  if (!["proof", "code", "call"].includes(String(input.kind))) throw new Error("invalid sponsored read kind");
  return { sessionId: read.sessionId, userKey: read.userKey, nonce: read.nonce, charge: read.charge,
    requestHash: read.readHash, expiresAt: read.expiresAt, kind: input.kind as SponsoredReadIntent["kind"] };
}

function parseDelegatedRead(value: unknown): DelegatedRead {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("missing delegated request");
  const input = value as Record<string, unknown>;
  const uint = (key: string) => {
    const value = input[key];
    if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) throw new Error(`invalid ${key}`);
    return BigInt(value);
  };
  if (typeof input.userKey !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input.userKey) || typeof input.readHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.readHash) || !Number.isSafeInteger(input.expiresAt)) throw new Error("invalid delegated request");
  return { sessionId: uint("sessionId"), nonce: uint("nonce"), charge: uint("charge"), userKey: input.userKey as Address, readHash: input.readHash as Hex, expiresAt: input.expiresAt as number };
}
