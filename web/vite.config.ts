import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build also loads from IPFS gateways and derpc.eth.limo.
  base: "./",
  // The logo kit lives in brand/ so every surface uses the same source files.
  publicDir: "../brand",
  server: { port: 5174, strictPort: true },
  build: { target: "es2022" },
});
