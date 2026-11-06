import { cpSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, defineConfig, type Plugin, type ViteDevServer } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(root, "../frontend");
// Survives this config being reloaded, so a restart can close the demo server it started before.
const demoKey = Symbol.for("derpc.dev.demo-server");
const demoSlot = globalThis as { [demoKey]?: ViteDevServer };

// Dev server only: serve the live demo (frontend/) under /demo/ on this server's port, the same layout
// `pnpm build:site` produces. The demo keeps its own Vite config, environment files and dev call log.
function demoUnderSite(): Plugin {
  return {
    name: "derpc-demo-under-site",
    apply: "serve",
    async configureServer(server) {
      await demoSlot[demoKey]?.close();
      const demo = await createServer({
        root: demoRoot,
        configFile: resolve(demoRoot, "vite.config.ts"),
        base: "/demo/",
        // A separate cache, so this doesn't fight a standalone demo server (pnpm dev) over one directory.
        cacheDir: resolve(demoRoot, "node_modules/.vite-site"),
        optimizeDeps: { force: server.config.optimizeDeps.force },
        server: { middlewareMode: true, ws: { server: server.httpServer ?? undefined } },
      });
      demoSlot[demoKey] = demo;
      server.httpServer?.once("close", () => void demo.close());
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        if (path === "/demo") return void res.writeHead(302, { Location: "/demo/" }).end();
        if (path.startsWith("/demo/") || path === "/__derpc-log") return void demo.middlewares(req, res, next);
        next();
      });
    },
  };
}

const brandFiles: [string, string][] = [
  ["derpc-lockup.svg", resolve(root, "../brand/derpc-lockup.svg")],
  ["derpc-logo-512.png", resolve(root, "../brand/derpc-logo-512.png")],
];

function brandPublicAssets(): Plugin {
  return {
    name: "brand-public-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        const name = url.replace(/^\//, "");
        const match = brandFiles.find(([file]) => file === name);
        if (!match) {
          next();
          return;
        }
        const [, src] = match;
        const body = readFileSync(src);
        res.setHeader("Content-Type", src.endsWith(".svg") ? "image/svg+xml" : "image/png");
        res.end(body);
      });
    },
    closeBundle() {
      const out = resolve(root, "dist");
      for (const [name, src] of brandFiles) {
        cpSync(src, resolve(out, name));
      }
    },
  };
}

export default defineConfig({
  // Relative asset paths so the build also loads from IPFS gateways and derpc.eth.limo.
  base: "./",
  // Favicon lives in web/public. Lockup and 512 logo are served from /brand at dev and copied into dist on build,
  // so git does not store the same blob twice (the pre-push hook rejects duplicate hashes).
  publicDir: "public",
  plugins: [brandPublicAssets(), demoUnderSite()],
  server: { port: 5174, strictPort: true },
  build: { target: "es2022" },
});
