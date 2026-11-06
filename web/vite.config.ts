import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build also loads from IPFS gateways and derpc.eth.limo.
  base: "./",
  // Favicon lives in web/public. Brand lockups are symlinked into public/ from ../brand.
  publicDir: "public",
  server: { port: 5174, strictPort: true },
  build: { target: "es2022" },
});
