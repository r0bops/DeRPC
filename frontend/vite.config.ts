import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build also loads from IPFS gateways and derpc.eth.limo.
  base: "./",
  server: { port: 5173, strictPort: true },
  build: {
    target: "es2022",
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
});
