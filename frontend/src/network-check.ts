// DeRPC network check: is the anonymous path working, and which endpoints serve proofs through it?
import {
  MAINNET_BEACON_ENDPOINTS,
  MAINNET_EXECUTION_ENDPOINTS,
  TOR_JS_PIN as PINNED_TOR_JS,
  startAnonTransport,
  withGateways,
  type AnonTransport,
  type WorkerPin,
} from "@derpc/provider";
import { renderStatus, renderWorkerFailure, tableRow, textCell } from "./render.ts";

// Gateways come from VITE_TOR_GATEWAYS (frontend/.env.local, comma-separated KPS addresses);
// without it, the tor-js demo gateway pinned in the provider config is used.
const configuredGateways = String(import.meta.env.VITE_TOR_GATEWAYS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GATEWAY_PIN = withGateways(PINNED_TOR_JS, configuredGateways);

const TOR_JS_PIN: WorkerPin = GATEWAY_PIN;
const gatewayLabel = configuredGateways.length ? `own gateway (${configuredGateways.length})` : "demo gateway";

// Network diagnostics (specs/ROADMAP.md, P1). Public fixtures only: no user addresses are sent anywhere.
// This page uses the low-level transport on purpose: it measures the network path, not the provider.
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const SLOT_0 = "0x" + "0".repeat(64);
const TOR_CHECK = "https://check.torproject.org/api/ip";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("worker-status");
const logEl = $("worker-log");
const runBtn = $<HTMLButtonElement>("run");
const resultsEl = $("results");
const directEl = $("direct");

const bootStarted = performance.now();
const elapsed = (from: number) => `${((performance.now() - from) / 1000).toFixed(1)} s`;

const transport: AnonTransport = startAnonTransport({
  pin: { ...TOR_JS_PIN, config: { ...TOR_JS_PIN.config, logLevel: "info" } },
  onLog: (line) => {
    logEl.textContent += `[${line.level}] ${line.text}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  },
  onState: (state, detail) => {
    if (state === "booting") statusEl.textContent = `booting ${TOR_JS_PIN.name} via ${gatewayLabel}…`;
    if (state === "ready") {
      renderStatus(statusEl, [
        { text: "ready", className: "ok" },
        { text: ` — ${TOR_JS_PIN.name} via ${gatewayLabel} after ${elapsed(bootStarted)}` },
      ]);
      runBtn.disabled = false;
    }
    if (state === "failed") renderWorkerFailure(statusEl, detail);
  },
});
transport.ready.catch(() => {});
const bootTicker = setInterval(() => {
  if (transport.state() !== "booting") return clearInterval(bootTicker);
  statusEl.textContent = `booting ${TOR_JS_PIN.name} via ${gatewayLabel}… ${elapsed(bootStarted)}`;
}, 500);

interface CheckResult { ok: boolean; detail: string; bytes?: number }

function addRow(name: string): (r: CheckResult, ms: number) => void {
  const tr = document.createElement("tr");
  const result = textCell("running…", "muted");
  const time = textCell("");
  const size = textCell("");
  tr.append(textCell(name), result, time, size);
  resultsEl.append(tr);
  return (r, ms) => {
    result.className = r.ok ? "ok" : "bad";
    result.textContent = r.detail;
    time.textContent = `${(ms / 1000).toFixed(2)} s`;
    size.textContent = r.bytes ? `${(r.bytes / 1024).toFixed(1)} KB` : "";
  };
}

async function check(name: string, fn: () => Promise<CheckResult>): Promise<CheckResult> {
  const done = addRow(name);
  const t = performance.now();
  let r: CheckResult;
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  done(r, performance.now() - t);
  return r;
}

async function rpc(url: string, method: string, params: unknown[], isolationKey?: string) {
  const res = await transport.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    isolationKey,
  });
  const text = await res.text();
  const json = JSON.parse(text) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return { result: json.result, bytes: text.length, status: res.status };
}

async function getJson(url: string, isolationKey?: string) {
  const res = await transport.fetch(url, { isolationKey });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 80)}`);
  return { json: JSON.parse(text) as Record<string, any>, bytes: text.length };
}

async function runChecks() {
  runBtn.disabled = true;
  resultsEl.replaceChildren();

  // A. Does traffic really leave through Tor? Observe exits under two isolation keys (P1 step 6).
  const exits: Record<string, string[]> = { "key-a": [], "key-b": [] };
  for (const key of ["key-a", "key-b", "key-a", "key-b"]) {
    await check(`Tor exit check (isolationKey ${key})`, async () => {
      const { json, bytes } = await getJson(TOR_CHECK, key);
      exits[key]!.push(String(json.IP));
      return { ok: json.IsTor === true, detail: `IsTor=${json.IsTor} exit ${json.IP}`, bytes };
    });
  }
  const a = new Set(exits["key-a"]), b = new Set(exits["key-b"]);
  const shared = [...a].filter((ip) => b.has(ip));
  await check("Isolation observation (not proof)", async () => ({
    ok: shared.length === 0,
    detail: shared.length === 0 ? `key-a exits {${[...a].join(", ")}} vs key-b exits {${[...b].join(", ")}}: no overlap` : `shared exit ${shared.join(", ")} (may happen by chance)`,
  }));

  // B. A real mainnet eth_getProof (WETH, slot 0, finalized) through each candidate execution endpoint.
  for (const url of MAINNET_EXECUTION_ENDPOINTS) {
    await check(`eth_getProof via ${new URL(url).host}`, async () => {
      const { result, bytes } = await rpc(url, "eth_getProof", [WETH, [SLOT_0], "finalized"], "probe-execution");
      const proof = result as { accountProof?: unknown[]; storageProof?: unknown[] };
      return { ok: Array.isArray(proof.accountProof), detail: `accountProof ${proof.accountProof?.length ?? 0} nodes, storageProof ${proof.storageProof?.length ?? 0}`, bytes };
    });
  }

  // C. The consensus data the Lodestar light client needs: finality checkpoint → bootstrap → optimistic update.
  for (const base of MAINNET_BEACON_ENDPOINTS) {
    const host = new URL(base).host;
    let root: string | undefined;
    await check(`finality checkpoint via ${host}`, async () => {
      const { json, bytes } = await getJson(`${base}/eth/v1/beacon/states/head/finality_checkpoints`, "probe-consensus");
      root = json.data?.finalized?.root;
      return { ok: Boolean(root), detail: `finalized epoch ${json.data?.finalized?.epoch}`, bytes };
    });
    if (root) {
      await check(`light_client/bootstrap via ${host}`, async () => {
        const { json, bytes } = await getJson(`${base}/eth/v1/beacon/light_client/bootstrap/${root}`, "probe-consensus");
        return { ok: Boolean(json.data?.header), detail: `slot ${json.data?.header?.beacon?.slot}`, bytes };
      });
    }
    await check(`light_client/optimistic_update via ${host}`, async () => {
      const { json, bytes } = await getJson(`${base}/eth/v1/beacon/light_client/optimistic_update`, "probe-consensus");
      return { ok: Boolean(json.data?.attested_header), detail: `attested slot ${json.data?.attested_header?.beacon?.slot}`, bytes };
    });
  }

  renderDirectConnections();
  runBtn.disabled = false;
}

// Every HTTP(S) request the page itself made, as seen by the browser (P1 step 5).
const RPC_HOSTS = new Set([...MAINNET_EXECUTION_ENDPOINTS, ...MAINNET_BEACON_ENDPOINTS, TOR_CHECK].map((u) => new URL(u).host));
const BUNDLE_HOSTS = new Set(TOR_JS_PIN.resolvers.filter((r) => r.startsWith("https:")).map((u) => new URL(u).host));

function renderDirectConnections() {
  const counts = new Map<string, number>();
  for (const entry of performance.getEntriesByType("resource")) {
    const host = new URL(entry.name).host;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  directEl.replaceChildren();
  for (const [host, n] of counts) {
    const kind = host === location.host ? ["page assets", "ok"]
      : BUNDLE_HOSTS.has(host) ? ["worker bundle download (expected, see README bypass table)", "warn"]
      : RPC_HOSTS.has(host) ? ["RPC/beacon request outside the worker — LEAK", "bad"]
      : ["unexpected", "bad"];
    directEl.append(tableRow([{ text: host }, { text: kind[0]!, className: kind[1] }, { text: String(n) }]));
  }
}

runBtn.addEventListener("click", () => void runChecks());
renderDirectConnections();
setInterval(renderDirectConnections, 3000);
