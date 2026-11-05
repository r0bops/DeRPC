import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build also loads from IPFS gateways and derpc.eth.limo.
  base: "./",
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
  resolve: {
    alias: [
      // @chainsafe/bls lists its "import" export before "browser", so bundlers pick the Node entry,
      // which loads native BLS (a .node binary). Use its WASM (herumi) implementation instead.
      { find: /^@chainsafe\/bls$/, replacement: "@chainsafe/bls/herumi" },
    ],
  },
});
