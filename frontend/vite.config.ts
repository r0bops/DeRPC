import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build also loads from IPFS gateways and derpc.eth.limo.
  base: "./",
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
});
