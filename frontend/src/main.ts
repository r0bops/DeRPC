// The DeRPC demo. It uses only the public API: createDeRPC, its viem transport, and the shipped config.
import {
  createDeRPC,
  simulatedLyingOperator,
  MAINNET_BEACON_ENDPOINTS,
  MAINNET_OPERATORS,
  MAINNET_TOKENS,
  TOR_JS_PIN,
  type DeRPCStatus,
  type PoolEvent,
  type WorkerPin,
  type DeRPCOperator,
  operatorUrl,
} from "@derpc/provider";
import { derpcTransport } from "@derpc/provider/viem";
import type { PaymentTerms } from "@derpc/provider/discovery";
import { PaymentClient } from "@derpc/payments";
import { createPublicClient, erc20Abi, formatUnits, isAddress, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { renderStatus as setText, tableRow, textCell, type StatusPart } from "./render.ts";
import { mountPaymentPanel } from "./payment-panel.ts";
import { OperatorObservations, renderOperatorDashboard } from "./operator-dashboard.ts";
import { defaultRouting, eligibleForAutomatic, parseRoutingPreferences, routingOptions, type RoutingMode, type RoutingPreferences } from "./routing-preferences.ts";

type Operator = DeRPCOperator & {
  source: "bootstrap" | "ens" | "personal"; website?: string; payment?: PaymentTerms; expiry?: number;
  listVerification?: "proven" | "unverified"; recordVerification?: "proven" | "unverified";
};
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pageStarted = performance.now();
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// The directory and demo share a path in the release bundle, but use separate Vite ports in development.
document.querySelectorAll<HTMLAnchorElement>("[data-product-page]").forEach(link => {
  const target = new URL("../", location.href);
  if (import.meta.env.DEV) { target.port = "5174"; target.pathname = "/"; }
  target.search = "";
  target.hash = `#/${link.dataset.productPage}`;
  link.href = target.href;
});

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
const ROUTING_KEY = "derpc:routing";
const choiceId = (operator: Operator) => operator.ens ?? operator.id ?? operator.url;
let available: Operator[] = MAINNET_OPERATORS.map(o => ({ ...o, source: "bootstrap" }));
let directorySource: "bootstrap" | "ens" = "bootstrap";
let personalNode: Operator | undefined;
let sensitiveSession = false;
function loadChoice(): Operator[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "[]");
    return Array.isArray(saved) ? available.filter((o) => saved.includes(choiceId(o))) : [];
  } catch {
    return [];
  }
}
function saveChoice(chosen: Operator[]) {
  try {
    // ENS choices require a fresh proven directory, never a mock bootstrap entry with the same name.
    localStorage.setItem(CHOICE_KEY, JSON.stringify(chosen.filter(o => o.source === "bootstrap").map(choiceId)));
  } catch {
    // Storage blocked (private window): the choice lasts for this page only.
  }
}
function loadRouting(): RoutingPreferences {
  try { return parseRoutingPreferences(localStorage.getItem(ROUTING_KEY)); } catch { return defaultRouting(); }
}
function persistRouting() {
  try { localStorage.setItem(ROUTING_KEY, JSON.stringify(activeRouting)); } catch { /* session-only choice */ }
}
function automaticOperators(preferences: RoutingPreferences): Operator[] {
  return available.filter(operator => eligibleForAutomatic(operator) &&
    (preferences.scope === "all" || preferences.allowedOperators.includes(choiceId(operator))));
}
const savedRouting = loadRouting();
const needsVerifiedRestore = savedRouting.source === "ens";
let activeRouting = needsVerifiedRestore ? defaultRouting() : savedRouting;
let chosen: Operator[] = needsVerifiedRestore ? [] : activeRouting.selection === "manual" ? loadChoice() : automaticOperators(activeRouting);
if (activeRouting.selection === "manual") activeRouting.allowedOperators = chosen.filter(o => o.source !== "personal").map(choiceId);
// A directory link can suggest a known bootstrap operator. It never changes the live pool or stored choice.
const requestedOperator = new URLSearchParams(location.search).get("operator");
let suggestedOperator = MAINNET_OPERATORS.find(operator => operator.ens === requestedOperator)?.ens;

// ---- DeRPC itself ----
let workerReadyAt: number | undefined;
let lightClientReadyAt: number | undefined;
let servedBy: string[] = [];
let paymentPanel: ReturnType<typeof mountPaymentPanel> | undefined;
const observations = new OperatorObservations();
const payments = new PaymentClient({ onChange: () => paymentPanel?.render() });

const derpc = createDeRPC({
  gateways,
  worker,
  operators: activeRouting.selection === "manual" ? chosen : available.filter(operator => eligibleForAutomatic(operator)),
  ...(activeRouting.selection !== "manual" ? { selection: activeRouting.selection, ...(activeRouting.scope === "selected" ? { allowedOperators: activeRouting.allowedOperators } : {}) } : {}),
  chainId: 1,
  payments,
  verifiedCalls: true,
  onStatus: (s) => {
    devLog("status", statusSummary(s));
    renderStatus(s);
  },
  onPoolEvent: (e) => {
    observations.record(e);
    devLog("pool", { ...e, endpoint: e.endpoint ? label(e.endpoint) : undefined });
    logEvent(e);
  },
  onWorkerLog: (line) => {
    if (sensitiveSession) return; // personal credentials or paid requests must not enter the development log
    devLog("worker", line);
    const log = $("worker-log");
    log.textContent += `[${line.level}] ${line.text}\n`;
    log.scrollTop = log.scrollHeight;
  },
});
const client = createPublicClient({ chain: mainnet, transport: derpcTransport(derpc) });
paymentPanel = mountPaymentPanel({
  payments,
  settle: (operatorId, close) => derpc.settlePayment(operatorId, { close }),
  onEnabledChange: (enabled) => { if (enabled) sensitiveSession = true; applyChoice(); },
  onFunded: (operator) => { if (operator) derpc.registerPaymentOperator(operator.endpoint); applyChoice(); },
});
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

  renderOperatorDashboard({ body: $("pool"), summary: $("pool-summary"), available, chosen, status: s, observations });
}
setInterval(() => renderStatus(derpc.status()), 1000);

// ---- 2 · Choose your operators ----
const operatorsEl = $("operators");
const useOperatorsBtn = $<HTMLButtonElement>("use-operators");
const choiceStatusEl = $("choice-status");

function renderOperators() {
  const selected = new Set(chosen.map(choiceId));
  const suggestion = available.find(operator => operator.source === "bootstrap" && operator.ens === suggestedOperator);
  if (suggestion) selected.add(choiceId(suggestion));
  $("operator-suggestion").textContent = suggestion ? `Suggested from the directory: ${suggestion.ens}. Review the choices and press Apply. Your active operators have not changed.` : "";
  operatorsEl.replaceChildren(...available.map((op, index) => {
    const id = `operator-${index}`;
    const checkbox = Object.assign(document.createElement("input"), { type: "checkbox", id, value: choiceId(op), checked: selected.has(choiceId(op)) });
    const check = document.createElement("td"); check.append(checkbox);
    const name = document.createElement("td");
    name.append(Object.assign(document.createElement("label"), { htmlFor: id, textContent: op.ens ?? "My own node" }));
    if (op.source === "bootstrap") name.append(Object.assign(document.createElement("span"), { className: "badge", textContent: "mock", title: "Bootstrap name; not read from ENS" }));
    if (op.source === "personal") name.append(Object.assign(document.createElement("span"), { className: "badge", textContent: "private" }));
    const price = op.payment ? `${op.payment.price} wei · test chain ${op.payment.chainId}` : "Free";
    const row = document.createElement("tr");
    row.append(check, name, textCell(op.operator ?? "operator"), textCell(op.source === "personal" ? "Unpublished onion" : new URL(op.url).host), textCell(price));
    return row;
  }));
  updateChoiceButton();
}

const ticked = () => {
  const names = [...operatorsEl.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
  return available.filter((o) => names.includes(choiceId(o)));
};
const routingMode = $<HTMLSelectElement>("routing-mode");
routingMode.value = activeRouting.selection;
$<HTMLInputElement>(`routing-scope-${activeRouting.selection === "manual" ? "all" : activeRouting.scope}`).checked = true;
if (needsVerifiedRestore) $("routing-restore").textContent = "Your saved ENS routing is paused. Select a bootstrap operator to load a proven directory, then apply your routing strategy again. No mock operator replaces a saved ENS identity.";

const MODE_HELP: Record<RoutingMode, string> = {
  manual: "Manual uses only checked operators. Changes take effect when you press Apply.",
  balanced: "Balanced weighs recent successful reads and latency on this device. Existing assignments stay with their operator until failure.",
  fastest: "Fastest prefers lower latency observed on this device. It learns from verified reads and does not race your query across operators.",
  reliable: "Reliable prefers successful verified reads observed on this device. It learns from reads; no global reputation score is implied.",
};
function proposedRouting(): RoutingPreferences {
  const selection = routingMode.value as RoutingMode;
  const scope = selection === "manual" ? "selected" : $<HTMLInputElement>("routing-scope-selected").checked ? "selected" : "all";
  return { version: 1, selection, scope, source: directorySource, allowedOperators: scope === "selected" ? ticked().filter(o => o.source !== "personal").map(choiceId) : [] };
}
function pendingOperators(preferences: RoutingPreferences): Operator[] {
  return preferences.selection === "manual" ? ticked() : automaticOperators(preferences);
}
function updateChoiceButton() {
  const proposed = proposedRouting();
  const next = pendingOperators(proposed);
  $("routing-scope").hidden = proposed.selection === "manual";
  operatorsEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach(input => {
    input.disabled = proposed.selection !== "manual" && proposed.scope === "all";
  });
  $("routing-help").textContent = MODE_HELP[proposed.selection];
  const freeCount = available.filter(operator => eligibleForAutomatic(operator)).length;
  $("routing-source").textContent = directorySource === "bootstrap"
    ? `Source: curated bootstrap list · mock ENS names. ${freeCount} eligible free operator(s), Ethereum mainnet only.`
    : `Source: ENS directory. ${freeCount} free operator(s) have proven list and records; unverified records cannot enter automatic selection.`;
  const same = proposed.selection === activeRouting.selection && proposed.scope === activeRouting.scope &&
    (proposed.scope === "all" || proposed.allowedOperators.join("\n") === activeRouting.allowedOperators.join("\n")) &&
    (proposed.selection !== "manual" || next.map(choiceId).join("\n") === chosen.map(choiceId).join("\n"));
  $("routing-pending").textContent = same ? "Showing the active routing settings." : `Pending: ${proposed.selection}, ${next.length} eligible operator(s). Press Apply to change active routing.`;
  useOperatorsBtn.disabled = proposed.selection === "manual" && next.length === 0 && chosen.length === 0;
  useOperatorsBtn.textContent = next.length === 0 ? "Apply empty list — stop reads" : `Apply ${proposed.selection} · ${next.length} operator${next.length === 1 ? "" : "s"}`;
}
operatorsEl.addEventListener("change", updateChoiceButton);
routingMode.addEventListener("change", updateChoiceButton);
$("routing-scope").addEventListener("change", updateChoiceButton);
renderOperators();
function effectiveOperators(): Operator[] {
  return activeRouting.selection === "manual"
    ? chosen.filter(o => !o.payment || paymentPanel?.enabled() && payments.has(o.id ?? o.url))
    : automaticOperators(activeRouting);
}
function showActiveChoice() {
  const active = effectiveOperators();
  const waiting = chosen.length - active.length;
  choiceStatusEl.textContent = `Active: ${activeRouting.selection} · ${active.length ? `using ${active.map(o => o.ens ?? "My own node").join(", ")}` : "no operators; reads are stopped"}${waiting > 0 ? ` · ${waiting} paid operator(s) wait for an enabled, funded test session.` : ""}`;
  paymentPanel?.setOperators(activeRouting.selection === "manual" ? chosen.flatMap(o => o.payment ? [{ id: o.id ?? o.url, name: o.ens ?? o.operator ?? "operator", payment: o.payment, endpoint: o }] : []) : []);
}
function applyChoice() {
  if (activeRouting.selection === "manual") derpc.setOperators(effectiveOperators());
  // Automatic payment/personal UI callbacks must not replace a proven directory or activate paid reads.
  showActiveChoice();
}
useOperatorsBtn.addEventListener("click", () => {
  const proposed = proposedRouting();
  const nextChosen = pendingOperators(proposed);
  try {
    const manualCandidates = nextChosen.filter(o => !o.payment || paymentPanel?.enabled() && payments.has(o.id ?? o.url));
    // The provider validates and replaces routing atomically, before a worker-pin read can start.
    const automaticDirectory = proposed.selection !== "manual" && directorySource === "ens";
    if (automaticDirectory && derpc.status().routing?.source !== "verified-ens") throw new Error("Prove the ENS operator list and records before enabling automatic routing. Refresh with the registrar pin and proven execution enabled.");
    const retainedProvenDirectory = automaticDirectory;
    derpc.setRouting(routingOptions(proposed), retainedProvenDirectory ? undefined : proposed.selection === "manual" ? manualCandidates : available.filter(operator => eligibleForAutomatic(operator)));
    chosen = nextChosen;
    activeRouting = proposed;
    suggestedOperator = undefined;
    $("operator-suggestion").textContent = "";
    $("routing-error").textContent = "";
    $("routing-restore").textContent = "";
    saveChoice(chosen); persistRouting(); showActiveChoice(); renderOperators();
    renderStatus(derpc.status());
    void readAll();
  } catch (error) {
    $("routing-error").textContent = `Routing was not changed: ${rootError(error).text}`;
  }
});

// A full refresh removes revoked/expired choices. Manual routing retains only prior choices; automatic routing adopts the proven eligible roster.
$("directory-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $<HTMLButtonElement>("refresh-directory");
  const state = $("directory-status");
  if (button.disabled) return;
  const ethRegistry = $<HTMLInputElement>("ens-registry").value.trim();
  const registrar = $<HTMLInputElement>("ens-registrar").value.trim();
  const codeHash = $<HTMLInputElement>("ens-code-hash").value.trim();
  if (!isAddress(ethRegistry) || registrar && (!isAddress(registrar) || !/^0x[\da-fA-F]{64}$/.test(codeHash))) {
    state.textContent = "Enter a valid .eth registry address. A registrar also needs its trusted 32-byte runtime hash."; state.className = "bad"; return;
  }
  button.disabled = true; button.textContent = "Reading the full directory…";
  state.textContent = "Reading every operator through Anon-RPC. This can take a few minutes over Tor."; state.className = "muted";
  try {
    const previous = new Set(chosen.map(choiceId));
    const result = await derpc.refreshDirectory({ ethRegistry, ...(registrar ? { registrar: { address: registrar as Hex, codeHash: codeHash as Hex } } : {}), verifiedRecords: $<HTMLInputElement>("ens-verified-records").checked });
    const refreshed = result.operators.map(o => ({ ...o, source: "ens" as const, listVerification: result.listVerification, recordVerification: result.recordVerification }));
    // An ENS name can rotate its URL. Observations about the old endpoint do not prove the new one.
    for (const old of available) {
      const replacement = refreshed.find(o => (o.id ?? o.url) === (old.id ?? old.url));
      if (old.source !== "personal" && (!replacement || replacement.url !== old.url || replacement.ens !== old.ens || replacement.wrapperIdentity?.signer !== old.wrapperIdentity?.signer)) observations.forget(old.id ?? old.url);
    }
    available = [...refreshed, ...(personalNode ? [personalNode] : [])];
    directorySource = "ens";
    chosen = activeRouting.selection === "manual" ? available.filter(o => previous.has(choiceId(o))) : automaticOperators(activeRouting);
    const removed = [...previous].filter(id => !chosen.some(o => choiceId(o) === id)).length;
    activeRouting = { ...activeRouting, source: "ens", ...(activeRouting.selection === "manual" ? { allowedOperators: chosen.filter(o => o.source !== "personal").map(choiceId) } : {}) };
    // refreshDirectory already applied revocation and, in automatic mode, the full proven roster.
    // Replacing candidates here would erase its authenticated directory provenance.
    saveChoice(chosen); persistRouting(); renderOperators(); showActiveChoice();
    state.textContent = `${result.operators.length} operators at block ${result.blockNumber}. List: ${result.listVerification}; records: ${result.recordVerification}.${result.recordVerification === "unverified" ? " Unverified discovery can change who sees your queries; answers still require proofs." : ""}${removed ? ` ${removed} previous choice(s) removed.` : ""}${!result.operators.length ? " No active operators remain; no public endpoint was selected automatically." : ""}`;
    state.className = result.recordVerification === "proven" ? "ok" : "warn";
    $("directory-rejected").replaceChildren(...result.rejected.map(entry => Object.assign(document.createElement("li"), { textContent: `${entry.name}: ${entry.reason}` })));
  } catch (error) { state.textContent = `Directory refresh failed: ${rootError(error).text}. Check the deployment addresses and retry.`; state.className = "bad"; }
  finally { button.disabled = false; button.textContent = "Refresh ENS directory"; }
});

$("personal-form").addEventListener("submit", event => {
  event.preventDefault();
  const state = $("personal-status");
  try {
    if (activeRouting.selection !== "manual") throw new Error("Apply Manual routing before adding a personal node. Automatic routing uses public free operators only.");
    const url = operatorUrl($<HTMLInputElement>("personal-endpoint").value.trim());
    const token = $<HTMLInputElement>("personal-token").value.trim();
    if (!url.hostname.endsWith(".onion") || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Use a valid v3 onion URL and the 64-character token printed by your wrapper setup.");
    const node: Operator = { id: "my-personal-node", url: url.href, priority: -1, operator: "My own node", personalToken: token, source: "personal" };
    // Validate with the provider before changing the visible choice.
    sensitiveSession = true;
    derpc.setOperators([...effectiveOperators().filter(o => o.source !== "personal"), node]);
    personalNode = node;
    observations.forget("my-personal-node");
    available = [...available.filter(o => o.source !== "personal"), node];
    chosen = [...chosen.filter(o => o.source !== "personal"), node];
    $<HTMLInputElement>("personal-token").value = "";
    $<HTMLInputElement>("personal-endpoint").value = "";
    state.textContent = "Your node is selected for this page. Its address and token are not saved or published."; state.className = "ok";
    $<HTMLButtonElement>("remove-personal").disabled = false;
    renderOperators(); applyChoice();
  } catch (error) { state.textContent = rootError(error).text; state.className = "bad"; }
});
$("remove-personal").addEventListener("click", () => {
  observations.forget("my-personal-node");
  personalNode = undefined; available = available.filter(o => o.source !== "personal"); chosen = chosen.filter(o => o.source !== "personal");
  $<HTMLButtonElement>("remove-personal").disabled = true; $("personal-status").textContent = "Personal node removed. The page forgot its token.";
  renderOperators(); applyChoice();
});

setInterval(() => {
  const now = Date.now() / 1000;
  const expired = new Set(available.filter(o => o.expiry !== undefined && o.expiry <= now).map(choiceId));
  if (!expired.size) return;
  available = available.filter(o => !expired.has(choiceId(o))); chosen = chosen.filter(o => !expired.has(choiceId(o)));
  if (activeRouting.selection !== "manual") {
    try { derpc.setRouting(routingOptions(activeRouting)); }
    catch (error) {
      derpc.close(); chosen = [];
      $("routing-error").textContent = `Routing stopped while removing expired listings: ${rootError(error).text}. Reload and refresh the directory.`;
    }
  }
  else activeRouting.allowedOperators = chosen.filter(o => o.source !== "personal").map(choiceId);
  saveChoice(chosen); persistRouting(); renderOperators(); applyChoice();
  $("directory-status").textContent = `${expired.size} expired operator(s) removed. Refresh ENS to discover renewed listings.`;
}, 1000);

$("verified-call-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $<HTMLButtonElement>("run-verified-call");
  const result = $("verified-call-result");
  const to = $<HTMLInputElement>("call-address").value.trim();
  const data = $<HTMLInputElement>("call-data").value.trim();
  if (!isAddress(to) || !/^0x(?:[\da-fA-F]{2})*$/.test(data)) { result.textContent = "Enter a contract address and even-length hex call data."; result.className = "bad"; return; }
  if (button.disabled) return;
  button.disabled = true; button.textContent = "Executing against proven state…";
  result.textContent = "Fetching and verifying the state needed by the call…"; result.className = "muted";
  try {
    const response = await derpc.verifiedCall({ to, data: data as Hex });
    result.textContent = `${response.value} · verified at block ${response.block.blockNumber}`; result.className = "ok";
  } catch (error) { result.textContent = `Call refused: ${rootError(error).text}`; result.className = "bad"; }
  finally { button.disabled = false; button.textContent = "Run verified call"; }
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
  if (!effectiveOperators().length) {
    const empty = textCell("No reads: apply a nonempty manual choice or automatic routing above.", "muted");
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
  injectLiarBtn.disabled = activeRouting.selection !== "manual" || !transportOk || derpc.status().operators.some((o) => o.id.startsWith("simulated-liar:"));
  renderDirectConnections();
}

readAgainBtn.addEventListener("click", () => void readAll());
injectLiarBtn.addEventListener("click", () => {
  injectLiarBtn.disabled = true;
  if (activeRouting.selection !== "manual") return;
  const active = effectiveOperators();
  if (!active.length) return;
  derpc.setOperators([simulatedLyingOperator(active[0]!), ...active]);
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
  const operator = [...available, ...chosen].find(o => o.id === id || o.url === id || o.ens === id);
  if (operator) return operator.ens ?? operator.operator ?? "operator";
  try { return new URL(id).host; } catch { return id; }
}

function logEvent(e: PoolEvent) {
  if (e.type === "invalid-proof") paymentPanel?.rejection(e.endpoint ? label(e.endpoint) : "Operator");
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
  if (!import.meta.env.DEV || sensitiveSession) return;
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
if (chosen.length && activeRouting.selection === "manual") applyChoice();
else showActiveChoice();
renderStatus(derpc.status());
void readAll();
derpc.ready.catch(() => {}); // shown in the start-up table and in every read
