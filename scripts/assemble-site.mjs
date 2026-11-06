import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../frontend/dist/", import.meta.url));
const site = fileURLToPath(new URL("../web/dist/", import.meta.url));
if (!existsSync(new URL("../frontend/dist/index.html", import.meta.url)) || !existsSync(new URL("../web/dist/index.html", import.meta.url))) {
  throw new Error("Build the site and release demo first (pnpm build:site).");
}
// Both Vite builds use relative assets, so the demo also works under an IPFS gateway path.
cpSync(frontend, `${site}/demo`, { recursive: true });
console.log("Deploy web/dist: directory at /, verified-read demo at /demo/.");
