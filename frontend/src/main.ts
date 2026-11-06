// The DeRPC demo. It uses only the public API: createDeRPC, its viem transport, and the shipped config.
import {
  createDeRPC,
  simulatedLyingOperator,
  ENS_NAMES_ARE_MOCK,
  MAINNET_BEACON_ENDPOINTS,
  MAINNET_OPERATORS,
  MAINNET_TOKENS,
  TOR_JS_PIN,
  type DeRPCStatus,
  type PoolEvent,
  type WorkerPin,
} from "@derpc/provider";
import { derpcTransport } from "@derpc/provider/viem";
import { createPublicClient, erc20Abi, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import { renderStatus as setText, tableRow, textCell, type StatusPart } from "./render.ts";

type Operator = (typeof MAINNET_OPERATORS)[number];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pageStarted = performance.now();
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// Gateways come from VITE_TOR_GATEWAYS (frontend/.env.local, comma-separated KPS addresses);
// without it, the tor-js demo gateway pinned in the provider config is used.
const gateways = String(import.meta.env.VITE_TOR_GATEWAYS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const gatewayLabel = gateways.length ? `own gateway (${gateways.length})` : "demo gateway";

// Dev-only fault injection, never in production builds:
//   ?fault=bad-worker-hash  boot from a wrong worker hash: the harness must reject the bundle, and nothing is read
const fault = import.meta.env.DEV ? new URLSearchParams(location.search).get("fault") : null;
const flipHash = (h: `0x${string}`) => `${h.slice(0, -1)}${h.endsWith("0") ? "1" : "0"}` as `0x${string}`;
const worker: WorkerPin | undefined = fault === "bad-worker-hash" ? { ...TOR_JS_PIN, workerHash: flipHash(TOR_JS_PIN.workerHash) } : undefined;
if (fault) document.title = `DeRPC — fault: ${fault}`;

// ---- The user's choice of operators, kept on this device only ----
const CHOICE_KEY = "derpc:chosen-operators";
function loadChoice(): Operator[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "[]");
    return Array.isArray(saved) ? MAINNET_OPERATORS.filter((o) => saved.includes(o.ens)) : [];
  } catch {
    return [];
  }
}
function saveChoice(chosen: Operator[]) {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(chosen.map((o) => o.ens)));
  } catch {
    // Storage blocked (private window): the choice lasts for this page only.
  }
}
let chosen: Operator[] = loadChoice();

// ---- DeRPC itself ----
let workerReadyAt: number | undefined;
let lightClientReadyAt: number | undefined;
let servedBy: string[] = [];

const derpc = createDeRPC({
  gateways,
  worker,
  operators: chosen,
  onStatus: (s) => {
    devLog("status", statusSummary(s));
    renderStatus(s);
  },
  onPoolEvent: (e) => {
    devLog("pool", { ...e, endpoint: e.endpoint ? label(e.endpoint) : undefined });
    logEvent(e);
  },
  onWorkerLog: (line) => {
    devLog("worker", line);
    const log = $("worker-log");
    log.textContent += `[${line.level}] ${line.text}\n`;
    log.scrollTop = log.scrollHeight;
  },
});
const client = createPublicClient({ chain: mainnet, transport: derpcTransport(derpc) });
// Dev-only handle for the browser console and automated checks. Not in production builds.
if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__derpc = { derpc, client };

// ---- 1 · Start-up ----
const MAINNET_GENESIS = 1606824023;
function renderStatus(s: DeRPCStatus) {
  const now = performance.now();
  const t = s.transport;
  if (t.state === "ready") workerReadyAt ??= now;
  setText($("worker-status"),
    t.state === "booting" ? [plain(`booting ${s.worker.name} via ${gatewayLabel}… ${seconds(now - pageStarted)}`)]
    : t.state === "ready" ? [tag("ready", "ok"), plain(` — ${s.worker.name} via ${gatewayLabel}, after ${seconds(workerReadyAt! - pageStarted)}`)]
    : t.state === "failed" ? [tag("failed", "bad"), plain(` — ${t.error ?? "unknown error"} (no direct fallback)`)]
    : [tag("closed", "bad"), plain(" — anonymous network cut; DeRPC never falls back to a direct request")]);

  const lc = s.lightClient;
  const checkpointDays = ((Date.now() / 1000 - (MAINNET_GENESIS + s.checkpoint.epoch * 384)) / 86400).toFixed(1);
  const checkpoint = `pinned checkpoint epoch ${s.checkpoint.epoch} (${checkpointDays} days old)`;
  if (lc.state === "verified") lightClientReadyAt ??= now;
  setText($("lc-status"), [
    ...(lc.state === "waiting" ? [plain("waiting for the worker…")]
    : lc.state === "syncing" ? [plain(`syncing from the ${checkpoint}…`)]
    : lc.state === "verified" ? [tag("verified", "ok"), plain(` — sync-committee signatures checked, ${seconds(lightClientReadyAt! - (workerReadyAt ?? pageStarted))} after the worker · ${checkpoint}`)]
    : [tag(lc.state, "bad"), plain(` — ${lc.error ?? ""}`)]),
    ...(lc.poll?.consecutiveFailures ? [plain(" · "), tag(`head poll failing ×${lc.poll.consecutiveFailures}`, "bad"), plain(` — ${lc.poll.lastError ?? "unknown error"}`)] : []),
  ]);
  if (lc.header) {
    const ageMin = ((Date.now() / 1000 - lc.header.timestamp) / 60).toFixed(1);
    $("lc-header").textContent = `${lc.header.blockNumber} (${ageMin} min ago) · hash ${short(lc.header.blockHash)} · state root ${short(lc.header.stateRoot)}`;
  }

  const p = s.pin;
  setText($("pin-status"),
    p.state === "waiting-for-operators" ? [plain("proven through your operators once you choose them (the check is a read too)")]
    : p.state === "waiting-for-light-client" ? [plain("waiting for the light client…")]
    : p.state === "checking" ? [plain(`proving ${s.worker.name}'s on-chain workerHash (specifier slot 1)…`)]
    : p.state === "verified" ? [tag("verified", "ok"), plain(` — on-chain workerHash ${short(p.workerHash!)} matches the pin at block ${p.block}`)]
    : p.state === "mismatch" ? [tag("rejected", "bad"), plain(` — ${p.error ?? ""}`)]
    : [tag("not verified yet", "warn"), plain(` — ${p.error ?? ""}; it runs again with the next read`)]);

  $("pool").replaceChildren(
    ...s.operators.map((o) => {
      const tier = o.priority < 0 ? "demo" : o.priority === 0 ? "preferred" : "fallback";
      const css = o.state === "eligible" ? "ok" : o.state === "excluded" ? "bad" : "warn";
      const name = textCell(label(o.id));
      if (o.operator) name.append(" ", Object.assign(document.createElement("span"), { className: "muted", textContent: `(${o.operator})` }));
      const row = tableRow([{ text: tier }, { text: o.state === "excluded" ? "excluded locally" : o.state, className: css }]);
      row.prepend(name);
      return row;
    }),
  );
}
setInterval(() => renderStatus(derpc.status()), 1000);

// ---- 2 · Choose your operators ----
const operatorsEl = $("operators");
const useOperatorsBtn = $<HTMLButtonElement>("use-operators");
const choiceStatusEl = $("choice-status");

operatorsEl.innerHTML = MAINNET_OPERATORS.map((op) => {
  const id = `op-${op.ens}`;
  return `<tr>
    <td><input type="checkbox" id="${id}" value="${op.ens}"${chosen.includes(op) ? " checked" : ""}></td>
    <td><label for="${id}">${op.ens}</label>${ENS_NAMES_ARE_MOCK ? '<span class="badge" title="placeholder name, not registered on ENS yet">mock</span>' : ""}</td>
    <td><a href="${op.website}" target="_blank" rel="noopener noreferrer">${op.operator}</a></td>
    <td>${new URL(op.url).host}</td>
    <td>${op.priority === 0 ? "proofs worked in every run" : "slower or intermittent"}</td>
  </tr>`;
}).join("");

const ticked = () => {
  const names = [...operatorsEl.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
  return MAINNET_OPERATORS.filter((o) => names.includes(o.ens));
};
function updateChoiceButton() {
  const n = ticked().length;
  useOperatorsBtn.disabled = n === 0;
  useOperatorsBtn.textContent = n === 0 ? "Choose at least one operator" : `Use these ${n} operator${n === 1 ? "" : "s"}`;
}
operatorsEl.addEventListener("change", updateChoiceButton);
updateChoiceButton();
useOperatorsBtn.addEventListener("click", () => {
  chosen = ticked();
  saveChoice(chosen);
  derpc.setOperators(chosen);
  choiceStatusEl.textContent = `using: ${chosen.map((o) => o.ens).join(", ")}`;
  void readAll();
});

// ---- 3 · Verified reads ----
const readsEl = $("reads");
const readAgainBtn = $<HTMLButtonElement>("read-again");
const injectLiarBtn = $<HTMLButtonElement>("inject-liar");
const cutNetworkBtn = $<HTMLButtonElement>("cut-network");
const WETH = MAINNET_TOKENS.WETH;
const UNISWAP_USDC_WETH_PAIR = "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc" as const; // public contract

interface Read {
  label: string;
  run: () => Promise<string>;
  /** A read DeRPC must refuse: the refusal is the expected result. */
  refused?: boolean;
}
const READS: Read[] = [
  {
    label: "ETH balance of the WETH contract · viem getBalance",
    run: async () => `${amount(await client.getBalance({ address: WETH.address, blockTag: "finalized" }), 18)} ETH`,
  },
  {
    label: "WETH balance of the Uniswap V2 USDC/WETH pair · proven storage slot",
    run: async () => `${amount((await derpc.reader.getTokenBalance(WETH, UNISWAP_USDC_WETH_PAIR)).value, WETH.decimals)} WETH`,
  },
  {
    label: "WETH contract code · viem getCode",
    run: async () => {
      const code = (await client.getCode({ address: WETH.address, blockTag: "finalized" })) ?? "0x";
      return `${(code.length - 2) / 2} bytes, matching the proven code hash`;
    },
  },
  {
    label: "WETH balanceOf through eth_call · viem readContract",
    refused: true,
    run: async () => {
      await client.readContract({ address: WETH.address, abi: erc20Abi, functionName: "balanceOf", args: [UNISWAP_USDC_WETH_PAIR] });
      return "answered";
    },
  },
];

let reading: Promise<void> = Promise.resolve();
function readAll(): Promise<void> {
  reading = reading.then(runReads); // one round at a time
  return reading;
}

async function runReads() {
  if (!chosen.length) {
    const empty = textCell("No reads yet: choose at least one operator above.", "muted");
    empty.colSpan = 4;
    const tr = document.createElement("tr");
    tr.append(empty);
    readsEl.replaceChildren(tr);
    return;
  }
  readsEl.replaceChildren();
  for (const read of READS) {
    const result = textCell("verifying…", "muted");
    const via = textCell("");
    const time = textCell("");
    const tr = document.createElement("tr");
    tr.append(textCell(read.label), result, via, time);
    readsEl.append(tr);
    servedBy = [];
    const t = performance.now();
    try {
      const text = await read.run();
      const block = derpc.status().lightClient.header?.blockNumber;
      result.textContent = `${text}${block ? ` · verified at block ${block}` : ""}`;
      result.className = read.refused ? "bad" : "ok";
      via.textContent = servedBy.at(-1) ?? "on-device cache (proven earlier at this block)";
    } catch (error) {
      const e = rootError(error);
      const expected = read.refused && e.code === 4200;
      result.textContent = expected ? `refused as expected — ${e.text}` : e.text;
      result.className = expected ? "warn" : "bad";
      via.textContent = servedBy.at(-1) ?? "nothing sent";
    }
    time.textContent = seconds(performance.now() - t);
    devLog("read", { read: read.label, result: result.textContent, via: via.textContent, time: time.textContent });
  }
  const transportOk = derpc.status().transport.state === "ready";
  readAgainBtn.disabled = false;
  cutNetworkBtn.disabled = !transportOk;
  injectLiarBtn.disabled = !transportOk || derpc.status().operators.some((o) => o.priority < 0);
  renderDirectConnections();
}

readAgainBtn.addEventListener("click", () => void readAll());
injectLiarBtn.addEventListener("click", () => {
  injectLiarBtn.disabled = true;
  derpc.setOperators([simulatedLyingOperator(chosen[0]!), ...chosen]);
  void readAll();
});
cutNetworkBtn.addEventListener("click", () => {
  cutNetworkBtn.disabled = injectLiarBtn.disabled = true;
  derpc.close();
  void readAll();
});

// ---- 4 · Your operators, live ----
function label(id: string): string {
  if (id.startsWith("simulated-liar:")) return "simulated lying operator";
  return MAINNET_OPERATORS.find((o) => o.url === id)?.ens ?? new URL(id).host;
}

function logEvent(e: PoolEvent) {
  if (e.type === "success" && e.endpoint) servedBy.push(label(e.endpoint));
  const li = document.createElement("li");
  li.className = e.type === "success" ? "ok" : e.type === "transient-failure" ? "warn" : e.type === "attempt" ? "" : "bad";
  const parts = [new Date(e.at).toISOString().slice(11, 19), e.type];
  if (e.endpoint) parts.push(label(e.endpoint));
  if (e.attempt) parts.push(`attempt ${e.attempt}`);
  if (e.type === "invalid-proof") parts.push("excluded locally");
  if (e.detail) parts.push(e.detail.slice(0, 160));
  li.textContent = parts.join(" · ");
  $("pool-events").prepend(li);
}

// ---- 5 · Direct connections: every HTTP(S) request the page itself made ----
const RPC_HOSTS = new Set([...MAINNET_OPERATORS.map((o) => o.url), ...MAINNET_BEACON_ENDPOINTS].map((u) => new URL(u).host));
const BUNDLE_HOSTS = new Set(TOR_JS_PIN.resolvers.filter((r) => r.startsWith("https:")).map((u) => new URL(u).host));

function renderDirectConnections() {
  const counts = new Map<string, number>();
  for (const entry of performance.getEntriesByType("resource")) {
    const host = new URL(entry.name).host;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  $("direct").replaceChildren(
    ...[...counts].map(([host, n]) => {
      const [kind, css]: [string, string] = host === location.host ? ["page assets", "ok"]
        : BUNDLE_HOSTS.has(host) ? ["worker bundle download (expected, disclosed)", "warn"]
        : RPC_HOSTS.has(host) ? ["RPC/beacon request outside the worker — LEAK", "bad"]
        : ["unexpected", "bad"];
      return tableRow([{ text: host }, { text: kind, className: css }, { text: String(n) }]);
    }),
  );
}
renderDirectConnections();
setInterval(renderDirectConnections, 3000);

// ---- helpers ----
/** Dev server only: mirror events to .dev-logs/calls.log (scripts/show-logs.sh). Changed statuses only. */
let lastStatus = "";
function devLog(kind: string, data: unknown) {
  if (!import.meta.env.DEV) return;
  const line = JSON.stringify({ at: new Date().toISOString(), kind, data });
  if (kind === "status") {
    const key = JSON.stringify(data);
    if (key === lastStatus) return;
    lastStatus = key;
  }
  void fetch("/__derpc-log", { method: "POST", body: line }).catch(() => {});
}
function statusSummary(s: DeRPCStatus) {
  return {
    transport: s.transport.state + (s.transport.error ? `: ${s.transport.error}` : ""),
    lightClient: s.lightClient.state + (s.lightClient.error ? `: ${s.lightClient.error}` : ""),
    block: s.lightClient.header?.blockNumber,
    pin: s.pin.state + (s.pin.error ? `: ${s.pin.error}` : ""),
    operators: s.operators.map((o) => `${label(o.id)}=${o.state}`).join(" "),
  };
}
function amount(value: bigint, decimals: number): string {
  const [whole, frac = ""] = formatUnits(value, decimals).split(".");
  return `${BigInt(whole!).toLocaleString("en-US")}.${frac.padEnd(4, "0").slice(0, 4)}`;
}
const short = (hex: string) => `${hex.slice(0, 10)}…`;
function plain(text: string): StatusPart {
  return { text };
}
function tag(text: string, className: string): StatusPart {
  return { text, className };
}

/** The DeRPC error under viem's wrapping: its EIP-1193 code and reason. */
function rootError(error: unknown): { code?: number; text: string } {
  const walk = (error as { walk?: () => unknown })?.walk;
  const root = (typeof walk === "function" ? walk.call(error) : error) as { code?: number; data?: { reason?: string }; name?: string; message?: string };
  const code = typeof root?.code === "number" ? root.code : undefined;
  const reason = root?.data?.reason ?? root?.name ?? "Error";
  return { code, text: `${code !== undefined ? `${code} · ` : ""}${reason}: ${root?.message ?? String(error)}` };
}

// Read as soon as DeRPC is ready if the user already chose operators on this device; otherwise wait for a choice.
if (chosen.length) choiceStatusEl.textContent = `your saved choice: ${chosen.map((o) => o.ens).join(", ")}`;
void readAll();
derpc.ready.catch(() => {}); // shown in the start-up table and in every read
