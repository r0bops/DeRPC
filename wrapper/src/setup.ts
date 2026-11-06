import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boundedText, validateEndpointId, validateOperatorName } from "./proxy.ts";

/** Build a public proposal only; this function never reads or replaces existing ENS records. */
export function createSetupRecordProposal(input: {
  name: string;
  signer: string;
  onion: string;
  endpointId?: string;
  paymentRecords?: Record<string, string>;
}) {
  validateOperatorName(input.name);
  if (!/^0x[\da-fA-F]{40}$/.test(input.signer)) throw new Error("expected signer address");
  assertOnionHostname(input.onion);
  const commonRecords = {
    "derpc.signer": input.signer,
    "derpc.caps": JSON.stringify({ chainId: 1, methods: ["eth_getProof", "eth_getCode"], beacon: true }),
  };
  if (input.endpointId !== undefined) {
    validateEndpointId(input.endpointId);
    if (Object.keys(input.paymentRecords ?? {}).length) throw new Error("multiple-endpoint operators are free-only");
    const endpoint = { id: input.endpointId, url: `http://${input.onion}/rpc`, beaconUrl: `http://${input.onion}/` };
    return {
      kind: "derpc-endpoint-record-proposal", version: 1,
      status: "merge-required-not-published", name: input.name, endpoint,
      // Deliberately not a deployment configuration: this one-node value is not the full list.
      singleEndpointRecord: { "derpc.endpoints": JSON.stringify({ version: 1, endpoints: [endpoint] }) },
      commonRecords,
      review: "Merge this endpoint into the complete reviewed operator endpoint list before publishing. Preserve sibling IDs and URLs, check the 8-endpoint/4-KiB bounds, and use the ENS planner to clear legacy records and scope the hot key. This proposal did not read current ENS records or verify registration.",
    };
  }
  return {
    name: input.name,
    "derpc.endpoint": `http://${input.onion}/rpc`,
    "derpc.beacon": `http://${input.onion}`,
    ...commonRecords,
    ...input.paymentRecords,
  };
}

function assertOnionHostname(host: string): void {
  if (!/^[a-z2-7]{56}\.onion$/.test(host)) throw new Error("Tor has no valid v3 hostname");
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const decoded: number[] = [];
  let bits = 0, accumulator = 0;
  for (const char of host.slice(0, 56)) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; decoded.push((accumulator >> bits) & 255); }
  }
  const checksum = createHash("sha3-256").update(".onion checksum").update(Uint8Array.from(decoded.slice(0, 32))).update(Uint8Array.of(3)).digest();
  if (decoded[34] !== 3 || decoded[32] !== checksum[0] || decoded[33] !== checksum[1]) throw new Error("Tor has no valid v3 hostname");
}

const cwd = fileURLToPath(new URL("..", import.meta.url));
const compose = ["compose", "-f", "compose.yaml", ...(process.env.DERPC_PERSONAL_TOKEN_FILE ? ["-f", "compose.personal.yaml"] : []), ...(process.env.DERPC_PAYMENT_ESCROW ? ["-f", "compose.payments.yaml"] : [])];
const docker = (...args: string[]) => execFileSync("docker", [...compose, ...args], { cwd, encoding: "utf8", timeout: 10_000 });
const rpc = async (url: string, method: string, params: unknown[]) => {
  const signal = AbortSignal.timeout(20_000);
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = JSON.parse(await boundedText(res, 4 * 1024 * 1024, signal));
  if (!res.ok || data.error || data.result == null) throw new Error(`${method} failed; check node sync and finalized proof retention`);
  return data.result;
};

async function main() {
try {
  validateOperatorName(process.env.DERPC_ENS_NAME);
  if (!/^0x[\da-fA-F]{40}$/.test(process.env.DERPC_SIGNER ?? "")) throw new Error("expected signer address");
  const endpointId = process.env.DERPC_ENDPOINT_ID || undefined;
  if (endpointId !== undefined) {
    validateEndpointId(endpointId);
    if (process.env.DERPC_PAYMENT_ESCROW) throw new Error("multiple-endpoint operators are free-only; remove payment configuration before running setup");
  }
  execFileSync("docker", [...compose, "up", "--build", "-d"], { cwd, stdio: "inherit" });
  let onion = "";
  const startupDeadline = Date.now() + 60_000;
  for (;;) {
    try {
      onion = docker("exec", "-T", "tor", "cat", "/var/lib/tor/pool/hostname").trim();
      const chain = await rpc("http://127.0.0.1:8787/rpc", "eth_chainId", []);
      if (chain !== "0x1") throw new Error("wrapper must serve Ethereum mainnet");
      break;
    } catch (error) {
      if (Date.now() >= startupDeadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  assertOnionHostname(onion);
  const block = await rpc(process.env.DERPC_EXECUTION_URL ?? "http://127.0.0.1:8545", "eth_getBlockByNumber", ["finalized", false]);
  // The pinned worker's slot is the narrowly unpaid bootstrap proof even in payment mode.
  const proof = await rpc("http://127.0.0.1:8787/rpc", "eth_getProof", ["0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e", ["0x1"], block.number]);
  if (!Array.isArray(proof.accountProof) || !proof.accountProof.length || !Array.isArray(proof.storageProof) || proof.storageProof.length !== 1 || !Array.isArray(proof.storageProof[0]?.proof) || !proof.storageProof[0].proof.length) throw new Error("node returned no account/storage proof at the finalized block");
  const signal = AbortSignal.timeout(20_000);
  const beacon = await fetch("http://127.0.0.1:8787/eth/v1/beacon/light_client/finality_update", { signal });
  const update = JSON.parse(await boundedText(beacon, 2 * 1024 * 1024, signal));
  if (!beacon.ok || !update.data?.finalized_header) throw new Error("enable beacon light-client serving and wait for sync");
  console.log("Local wrapper self-test passed (onion reachability must still be tested through Anon-RPC).");
  const paymentRecords: Record<string, string> = {};
  if (process.env.DERPC_PAYMENT_ESCROW) {
    const { readFileSync } = await import("node:fs");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { isAddress } = await import("viem");
    const keyFile = process.env.DERPC_SETTLEMENT_KEY_FILE;
    if (!keyFile) throw new Error("DERPC_SETTLEMENT_KEY_FILE is required in payment mode");
    const key = readFileSync(keyFile, "utf8").trim();
    if (!/^0x[\da-fA-F]{64}$/.test(key)) throw new Error("settlement key file must contain a 0x-prefixed 32-byte key");
    const price = process.env.DERPC_PRICE_WEI ?? "";
    const chain = process.env.DERPC_PAYMENT_CHAIN_ID ?? "";
    if (!/^[1-9]\d*$/.test(price) || !/^[1-9]\d*$/.test(chain) || !isAddress(process.env.DERPC_PAYMENT_ESCROW)) throw new Error("invalid payment records");
    paymentRecords["derpc.price"] = price;
    paymentRecords["derpc.payee"] = privateKeyToAccount(key as `0x${string}`).address;
    paymentRecords["derpc.paymentChain"] = chain;
    paymentRecords["derpc.escrow"] = process.env.DERPC_PAYMENT_ESCROW;
  }
  console.log(JSON.stringify(createSetupRecordProposal({
    name: process.env.DERPC_ENS_NAME ?? "", signer: process.env.DERPC_SIGNER ?? "",
    onion, endpointId, paymentRecords,
  }), null, 2));
} catch (error) {
  console.error(`Setup failed: ${error instanceof Error ? error.message : "unknown error"}. ENS records were not published.`);
  process.exitCode = 1;
}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
