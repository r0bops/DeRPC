import { cpSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

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
  plugins: [brandPublicAssets()],
  server: { port: 5174, strictPort: true },
  build: { target: "es2022" },
});
