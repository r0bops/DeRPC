import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

/** Loopback only. Tor is the public ingress; the node API is never published. */
export function serve(handler: (request: Request) => Promise<Response>, port: number): Server {
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 20_000, headersTimeout: 10_000 }, async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const method = req.method ?? "GET";
      // Reject absolute-form targets, fragments, backslashes and encoded path separators.
      const path = req.url ?? "/";
      if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path) || /%2f|%5c/i.test(path)) {
        res.writeHead(400); res.end(); return;
      }
      const request = new Request(`http://127.0.0.1:${port}${path}`, {
        method, headers: req.headers as Record<string, string>, signal: controller.signal,
        ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(req), duplex: "half" }),
      } as RequestInit);
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  server.maxConnections = 64;
  server.listen(port, "127.0.0.1");
  return server;
}
