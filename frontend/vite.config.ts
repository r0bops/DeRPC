import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { TOR_JS_DEMO_GATEWAY } from "../provider/src/config/mainnet.ts";
import { findNonPublicAddresses, releaseGateways } from "./build/gateways.ts";

export default defineConfig(({ command, mode }) => {
  const release = command === "build" && mode !== "lan";
  const gateways = release ? releaseGateways(process.env.VITE_TOR_GATEWAYS, TOR_JS_DEMO_GATEWAY) : undefined;
  return {
    // Relative asset paths so the build also loads from IPFS gateways and derpc.eth.limo.
    base: "./",
    ...(release ? { envDir: false as const, define: { "import.meta.env.VITE_TOR_GATEWAYS": JSON.stringify(gateways!.join(",")) } } : {}),
    plugins: release ? [refuseNonPublicAddresses()] : [],
    server: { port: 5173, strictPort: true },
    build: {
      target: "es2022",
      outDir: mode === "lan" ? "dist-local" : "dist",
      // Three pages: the demo, the smallest integrator example, and the network diagnostics.
      rolldownOptions: { input: { demo: "index.html", example: "example.html", check: "network-check.html" } },
    },
    resolve: {
      alias: [
        // @chainsafe/bls lists its "import" export before "browser", so bundlers pick the Node entry,
        // which loads native BLS (a .node binary). Use its WASM (herumi) implementation instead.
        { find: /^@chainsafe\/bls$/, replacement: "@chainsafe/bls/herumi" },
      ],
    },
  };
});

/** Scan every emitted text asset, including sourcemaps, before accepting a release build. */
function refuseNonPublicAddresses(): Plugin {
  return {
    name: "derpc:refuse-non-public-addresses",
    apply: "build",
    writeBundle(options) {
      const hits = readdirSync(options.dir!, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .flatMap((entry) => {
          const path = join(entry.parentPath, entry.name);
          const bytes = readFileSync(path);
          if (bytes.includes(0)) return [];
          return findNonPublicAddresses(bytes.toString("utf8")).map((address) => `${address} in ${path}`);
        });
      if (hits.length) this.error(`release build contains non-public addresses: ${hits.join("; ")}`);
    },
  };
}
