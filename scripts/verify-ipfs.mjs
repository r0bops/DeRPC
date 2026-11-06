// Fetch every file of a packaged release through public IPFS gateways and compare it with the manifest.
// Run it after pinning and before the ENS record changes. It only reads public gateways.
// Usage: node scripts/verify-ipfs.mjs [web/out/ipfs-release/manifest.json] [--gateway https://{cid}.ipfs.dweb.link]...
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
// {cid} is replaced with the root CID. Subdomain gateways first: they serve the site the way eth.limo does.
export const DEFAULT_GATEWAYS = ["https://{cid}.ipfs.dweb.link", "https://ipfs.io/ipfs/{cid}"];

async function fetchBytes(url, timeoutMs) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Resolves with the gateway that served every file correctly; throws when none did within the attempts. */
export async function verifyRetrieval({ manifest, gateways = DEFAULT_GATEWAYS, attempts = 6, delayMs = 20_000, timeoutMs = 60_000, paceMs = 400, log = console.log }) {
  const paths = Object.keys(manifest.files);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const template of gateways) {
      const base = template.replace("{cid}", manifest.cid);
      try {
        for (const [index, path] of paths.entries()) {
          // Public gateways rate-limit bursts (HTTP 429), so files are fetched one at a time with a pause.
          if (index && paceMs) await new Promise(done => setTimeout(done, paceMs));
          const bytes = await fetchBytes(`${base}/${path}`, timeoutMs);
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (digest !== manifest.files[path]) throw new Error(`${path}: bytes differ from the manifest`);
        }
        return { gateway: base, filesChecked: paths.length };
      } catch (error) {
        lastError = `${base}: ${error instanceof Error ? error.message : error}`;
        log(`attempt ${attempt}/${attempts} failed at ${lastError}`);
      }
    }
    if (attempt < attempts) await new Promise(done => setTimeout(done, delayMs));
  }
  throw new Error(`No gateway served all ${paths.length} files. Last error: ${lastError}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const gateways = args.flatMap((arg, index) => arg === "--gateway" && args[index + 1] ? [args[index + 1]] : []);
  const path = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--gateway") ?? resolve(REPOSITORY, "web/out/ipfs-release/manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(resolve(path), "utf8"));
    const result = await verifyRetrieval({ manifest, ...(gateways.length ? { gateways } : {}) });
    console.log(`PASS: ${result.filesChecked} files match the manifest through ${result.gateway}.`);
    console.log("This shows public retrieval now, not durable pinning or the ENS record.");
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
