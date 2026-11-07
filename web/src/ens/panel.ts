import "./wallet.css";
// @ts-expect-error Browser-safe shared wallet controller remains JavaScript for CLI reuse.
import { createENSWalletController, createENSWalletDiscovery } from "../../../contracts/scripts/ens-wallet-client.mjs";
import { createBrowserSession, savedBrowserSession, serialise, type Data } from "./session.ts";
import type { OperatorRuntime } from "./runtime.ts";

export const operatorWalletHtml = () => `<section id="operator-wallet" class="ens-wallet panel" aria-labelledby="operator-wallet-title">
  <p class="panel__kicker">Ethereum mainnet · operator wallet</p>
  <h2 id="operator-wallet-title">Register and manage your operator</h2>
  <p id="ens-availability" role="status">Checking the website's registrar configuration…</p>
  <p id="ens-admin-sources" class="field__hint"></p>
  <p>Registration uses three separately reviewed transactions: create your resolver, grant its endpoint-update key, then register your name. Renewal uses the operator wallet; endpoint changes use the scoped endpoint key. Calls transfer zero ETH, but mainnet gas costs real ETH.</p>
  <div class="ens-actions">
    <button id="ens-prepare-join" class="btn btn--lime" type="button" disabled>Check name and prepare registration</button>
    <button id="ens-resume" class="btn btn--ghost" type="button" disabled>Resume saved operation</button>
  </div>
  <details id="ens-management"><summary>Renew a lease or update endpoints</summary>
    <p class="field__hint">Use an operator in the configured deployment, or import your downloaded enrollment evidence. Imported evidence is checked against the configured pins and replayed on-chain before any transaction is enabled.</p>
    <label class="field" for="ens-enrollment-file">Enrollment evidence JSON (optional)<input id="ens-enrollment-file" type="file" accept="application/json,.json" disabled></label>
    <label class="field" for="ens-managed-operator">Operator<select id="ens-managed-operator" disabled></select></label>
    <label class="field" for="ens-management-kind">Action<select id="ens-management-kind" disabled><option value="renew">Renew lease</option><option value="endpoint">Update endpoint record</option></select></label>
    <p id="ens-current-record" class="field__hint"></p>
    <label class="field" for="ens-expected-expiry">Current expected lease expiry (UTC)<input id="ens-expected-expiry" type="datetime-local" step="1" disabled></label>
    <label class="field" for="ens-renew-expiry">New lease expiry (UTC)<input id="ens-renew-expiry" type="datetime-local" step="1" disabled></label>
    <label class="field" for="ens-expected-endpoint" hidden>Current expected endpoint URL or endpoint-list JSON<textarea id="ens-expected-endpoint" rows="4" disabled></textarea></label>
    <label class="field" for="ens-new-endpoint" hidden>New endpoint URL or full endpoint-list JSON<textarea id="ens-new-endpoint" rows="4" disabled></textarea></label>
    <button id="ens-prepare-management" class="btn btn--ghost" type="button" disabled>Check authority and prepare action</button>
  </details>
  <p id="ens-web-message" role="status" aria-live="polite"></p>
  <section id="ens-wallet-review" hidden>
    <h3 id="ens-stage-title" tabindex="-1">Review your transaction</h3>
    <p>Wallet connection never sends a transaction. Check the exact sender, destination and calldata below; each send requires your review checkbox and a separate wallet confirmation.</p>
    <label class="field" for="ens-web-wallet">Wallet extension<select id="ens-web-wallet"></select></label>
    <div class="ens-actions"><button id="ens-web-detect" class="btn btn--ghost" type="button">Detect wallets</button><button id="ens-web-connect" class="btn btn--ghost" type="button">Connect selected wallet</button><button id="ens-web-switch" class="btn btn--ghost" type="button" disabled>Switch to Ethereum mainnet</button></div>
    <p id="ens-wallet-account"></p>
    <div id="ens-transaction-list"></div>
    <dl id="ens-transaction-summary" class="kv"></dl>
    <details><summary>Exact calldata and wallet request</summary><pre id="ens-exact-request" tabindex="0"></pre></details>
    <details><summary>Reviewed public configuration, roles and gas estimate</summary><pre id="ens-exact-plan" tabindex="0"></pre></details>
    <label class="ens-review-check"><input id="ens-web-reviewed" type="checkbox" disabled> I reviewed this exact transaction and sender, Ethereum mainnet, zero transferred ETH and real gas fees.</label>
    <button id="ens-web-send" class="btn btn--lime" type="button" disabled>Send this transaction in wallet</button>
    <div class="ens-actions"><button id="ens-web-refresh" class="btn btn--ghost" type="button">Refresh receipts / next stage</button><button id="ens-web-verify" class="btn btn--ghost" type="button" disabled>Verify completed operation</button></div>
    <p class="field__hint">Final verification requires at least 12 canonical confirmations from both administrative sources. Finalized discovery and anonymous endpoint reachability are separate checks.</p>
    <pre id="ens-web-hashes" tabindex="0"></pre>
    <label class="field" for="ens-web-reconcile-hash">Original transaction hash for a pending result<input id="ens-web-reconcile-hash" type="text" placeholder="0x…" autocomplete="off" spellcheck="false"></label>
    <button id="ens-web-reconcile" class="btn btn--ghost" type="button" disabled>Reconcile original hash</button>
    <p class="field__hint">Uncertain submissions stay locked after reload. Check wallet history and reconcile the original hash. Clearing browser data loses recovery evidence; download it before changing devices.</p>
    <div class="ens-actions"><button id="ens-download-journal" class="btn btn--ghost" type="button">Download recovery journal</button><button id="ens-download-evidence" class="btn btn--ghost" type="button" disabled>Download verified evidence</button><button id="ens-archive" class="btn btn--ghost" type="button" disabled>Archive completed operation</button><button id="ens-discard" class="btn btn--ghost" type="button">Discard unsent review</button></div>
  </section>
</section>`;

interface PanelOptions {
  operator(): Data | undefined;
  loadRuntime?: () => Promise<OperatorRuntime>;
  target?: Window;
}
export function mountOperatorWallet(root: HTMLElement, options: PanelOptions) {
  const target = options.target ?? window;
  const get = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const button = (id: string) => get<HTMLButtonElement>(id);
  let runtime: OperatorRuntime | undefined, session: Awaited<ReturnType<typeof createBrowserSession>> | undefined;
  let controller: any, discovery: any, wallets: Data[] = [], enrollment: Data | undefined, managed: Data[] = [];
  let closed = false, busy = false, generation = 0;
  const message = (text: string) => { if (!closed) get("ens-web-message").textContent = text; };
  const failure = (error: unknown) => message(error instanceof Error ? error.message : "The operator operation failed. Existing submissions remain saved.");
  const run = (fn: () => Promise<unknown>) => { if (closed || busy) return; void fn().catch(failure); };
  const controls = () => {
    const disabled = !runtime?.configured || busy || closed;
    for (const id of ["ens-prepare-join", "ens-resume", "ens-prepare-management", "ens-enrollment-file", "ens-managed-operator", "ens-management-kind", "ens-expected-expiry", "ens-renew-expiry", "ens-expected-endpoint", "ens-new-endpoint"]) (get(id) as HTMLButtonElement).disabled = disabled;
  };
  const invalidate = () => {
    generation++; controller?.close(); controller = undefined; get("ens-wallet-review").hidden = true;
    message("Inputs changed. Prepare or resume the saved operation and review again. Existing submissions remain locked.");
  };
  const managedFields = () => {
    const op = managed.find(value => value.name === get<HTMLSelectElement>("ens-managed-operator").value);
    const renew = get<HTMLSelectElement>("ens-management-kind").value === "renew";
    get("ens-renew-expiry").parentElement!.hidden = !renew; get("ens-new-endpoint").parentElement!.hidden = renew;
    get("ens-expected-expiry").parentElement!.hidden = !renew; get("ens-expected-endpoint").parentElement!.hidden = renew;
    if (op) { get<HTMLInputElement>("ens-expected-expiry").value = new Date(Number(op.expiry) * 1000).toISOString().slice(0, 19); get<HTMLTextAreaElement>("ens-expected-endpoint").value = op.records["derpc.endpoints"] || op.records["derpc.endpoint"] || ""; }
    get("ens-current-record").textContent = op ? `${op.name} · owner ${op.operator} · endpoint key ${op.hotKey}. Imported/configured evidence is awaiting a fresh on-chain check. Current evidence: ${renew ? `expiry ${new Date(Number(op.expiry) * 1000).toISOString()}` : op.records["derpc.endpoints"] || op.records["derpc.endpoint"]}` : "No operator evidence loaded.";
  };
  const populateOperators = () => {
    managed = runtime?.configured ? runtime.operators(enrollment) : [];
    const select = get<HTMLSelectElement>("ens-managed-operator"); select.replaceChildren();
    for (const op of managed) { const option = document.createElement("option"); option.value = op.name; option.textContent = op.name; select.append(option); }
    managedFields();
  };
  const render = (state: Data) => {
    if (closed) return;
    busy = state.busy; controls(); get("ens-wallet-review").hidden = false;
    get("ens-stage-title").textContent = `${state.complete ? "Verified" : state.readyToVerify ? "Ready for final verification" : "Review stage"}: ${state.plan.stage}`;
    message(state.message);
    get("ens-wallet-account").textContent = `${state.walletName || "No wallet selected"} · account ${state.account ?? "not connected"} · chain ${state.chainId ?? "unknown"}`;
    const list = get("ens-transaction-list"); list.replaceChildren();
    for (const tx of state.plan.transactions) {
      const saved = state.entries.find((entry: Data) => entry.id === tx.id), row = document.createElement("div"), choose = document.createElement("button");
      row.className = "ens-transaction"; const label = document.createElement("p"); label.textContent = `${tx.purpose} · ${saved.status}`; row.append(label);
      choose.type = "button"; choose.className = "btn btn--ghost btn--small"; choose.textContent = tx.id === state.selectedId ? "Selected transaction" : "Review this transaction";
      choose.disabled = state.busy || state.complete;
      choose.addEventListener("click", () => { try { controller.selectTransaction(tx.id); get("ens-stage-title").focus(); } catch (error) { failure(error); } }); row.append(choose); list.append(row);
    }
    const tx = state.plan.transactions.find((item: Data) => item.id === state.selectedId), request = tx?.walletRequest.params[0];
    const summary = get("ens-transaction-summary"); summary.replaceChildren();
    if (request) for (const [name, value] of [["Sender", request.from], ["Destination", request.to], ["Network", "Ethereum mainnet · chain 1"], ["Transferred ETH", "0 ETH; gas costs real ETH"], ["Estimated gas", tx.estimatedGas ?? "Not available"]]) {
      const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = name; dd.textContent = value; summary.append(dt, dd);
    }
    get("ens-exact-request").textContent = tx ? serialise(tx.walletRequest) : "Select a transaction to inspect its exact request.";
    get("ens-exact-plan").textContent = serialise(state.plan);
    button("ens-web-connect").disabled = state.busy || !wallets.length || state.complete;
    button("ens-web-detect").disabled = state.busy; get<HTMLSelectElement>("ens-web-wallet").disabled = state.busy;
    button("ens-web-switch").disabled = !state.canSwitchNetwork;
    const review = get<HTMLInputElement>("ens-web-reviewed"); review.checked = state.reviewed; review.disabled = !state.canReview;
    button("ens-web-send").disabled = !state.canSend; button("ens-web-refresh").disabled = state.busy; button("ens-web-verify").disabled = !state.canVerify;
    const entry = state.entries.find((item: Data) => item.id === state.selectedId);
    button("ens-web-reconcile").disabled = state.busy || !entry || !["pending", "submitted"].includes(entry.status);
    get("ens-web-hashes").textContent = state.hashes.map((item: Data) => `${item.id}: ${item.hash}`).join("\n") || "No transaction hash returned in this session.";
    button("ens-download-evidence").disabled = !state.complete; button("ens-archive").disabled = !state.complete || state.busy;
    button("ens-discard").disabled = state.busy || !!session?.export().stages.some((stage: Data) => stage.entries.some((entry: Data) => entry.status !== "ready" || entry.hash || entry.attempted));
  };
  const selectWallet = () => { const wallet = wallets.find(item => item.id === get<HTMLSelectElement>("ens-web-wallet").value); if (wallet && controller) controller.selectWallet(wallet.provider, wallet.name); };
  const attach = async (prepared: { config: Data; adapter: any }) => {
    const version = ++generation; controller?.close(); controller = undefined; busy = true; controls(); message("Checking the name, reviewed registrar runtime and exact authority with both administrative RPC sources…");
    try {
      const next = await createBrowserSession({ ...prepared, clients: runtime!.clients, storage: target.localStorage, locks: target.navigator.locks });
      if (closed || version !== generation) return;
      session = next;
      controller = createENSWalletController({ initialState: session.state(), action: session.action, onChange: (state: Data) => { if (version === generation) render(state); } });
      selectWallet(); render(controller.state()); get("ens-stage-title").focus();
    } finally { busy = false; controls(); }
  };
  button("ens-prepare-join").addEventListener("click", () => run(async () => { const operator = options.operator(); if (!operator) throw new Error("Complete and review the operator fields first."); await attach(runtime!.join(operator)); }));
  button("ens-resume").addEventListener("click", () => run(async () => { const saved = savedBrowserSession(target.localStorage); if (!saved) throw new Error("No saved operator operation exists on this browser origin."); await attach(runtime!.restore(saved)); }));
  get("ens-managed-operator").addEventListener("change", () => { invalidate(); managedFields(); });
  get("ens-management-kind").addEventListener("change", () => { invalidate(); managedFields(); });
  for (const id of ["ens-expected-expiry", "ens-renew-expiry", "ens-expected-endpoint", "ens-new-endpoint"]) get(id).addEventListener("input", invalidate);
  get<HTMLInputElement>("ens-enrollment-file").addEventListener("change", () => run(async () => {
    invalidate(); const version = generation, file = get<HTMLInputElement>("ens-enrollment-file").files?.[0];
    if (!file) { enrollment = undefined; populateOperators(); return; }
    if (file.size > 512 * 1024) throw new Error("Enrollment evidence is limited to 512 KiB.");
    const contents = await file.text(); if (closed || generation !== version) return;
    const candidate = JSON.parse(contents); runtime!.operators(candidate); enrollment = candidate; populateOperators();
    message("Evidence loaded as an input. Its pins, receipts and authority must pass both live administrative checks before signing.");
  }));
  button("ens-prepare-management").addEventListener("click", () => run(async () => {
    const op = managed.find(value => value.name === get<HTMLSelectElement>("ens-managed-operator").value); if (!op) throw new Error("Choose an operator first.");
    const label = op.name.slice(0, -".derpc.eth".length), renew = get<HTMLSelectElement>("ens-management-kind").value === "renew";
    const raw = get<HTMLTextAreaElement>("ens-new-endpoint").value.trim();
    const expected = get<HTMLTextAreaElement>("ens-expected-endpoint").value.trim();
    const action = renew ? { type: "renew", label, expectedExpiry: Date.parse(`${get<HTMLInputElement>("ens-expected-expiry").value}Z`) / 1000, expiry: Date.parse(`${get<HTMLInputElement>("ens-renew-expiry").value}Z`) / 1000, authority: "operator" }
      : op.records["derpc.endpoints"] ? { type: "rotate-endpoints", label, expectedEndpoints: JSON.parse(expected), newEndpoints: JSON.parse(raw) }
        : { type: "rotate-endpoint", label, expectedEndpoint: expected, newEndpoint: raw };
    await attach(runtime!.manage(action, enrollment));
  }));
  get("ens-web-wallet").addEventListener("change", () => { try { selectWallet(); } catch (error) { failure(error); } });
  button("ens-web-detect").addEventListener("click", () => discovery?.refresh());
  for (const [id, action] of [["ens-web-connect", "connect"], ["ens-web-switch", "switchNetwork"], ["ens-web-send", "send"], ["ens-web-refresh", "refresh"], ["ens-web-verify", "verify"]]) button(id!).addEventListener("click", () => run(async () => { if (!controller) throw new Error("Prepare or resume an operation first."); await controller[action!](); }));
  get<HTMLInputElement>("ens-web-reviewed").addEventListener("change", event => controller?.setReviewed((event.target as HTMLInputElement).checked));
  button("ens-web-reconcile").addEventListener("click", () => run(async () => controller.reconcile(controller.state().selectedId, get<HTMLInputElement>("ens-web-reconcile-hash").value.trim())));
  const download = (value: Data, name: string) => { const url = URL.createObjectURL(new Blob([serialise(value) + "\n"], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  button("ens-download-journal").addEventListener("click", () => { if (session) download(session.export(), "derpc-operator-recovery.json"); });
  button("ens-download-evidence").addEventListener("click", () => { const manifest = session?.state().manifest; if (manifest) download(manifest, "derpc-operator-verified-evidence.json"); });
  for (const [id, action] of [["ens-archive", "archive"], ["ens-discard", "discardUnsent"]] as const) button(id).addEventListener("click", () => run(async () => { await session?.[action](); invalidate(); session = undefined; message(action === "archive" ? "Completed evidence archived in this browser. You can prepare another operation." : "Unsent review discarded. You can change inputs and prepare a fresh plan."); }));
  void (options.loadRuntime ?? (async () => (await import("./configured.ts")).operatorRuntime()))().then(value => {
    if (closed) return; runtime = value;
    get("ens-availability").textContent = runtime.configured ? "A reviewed registrar deployment is configured. Live name, runtime and authority checks are still required before signing." : "Wallet registration and management are disabled: no verified public registrar deployment is configured. You can still prepare and download a local draft below.";
    get("ens-admin-sources").textContent = `Administrative checks contact ${runtime.origins.join(" and ")} directly. These sources see your IP and operator data. They are separate from DeRPC's anonymous verified user reads; no direct read fallback is enabled.`;
    populateOperators(); controls();
    if (!runtime.configured) return;
    discovery = createENSWalletDiscovery(target, (list: Data[]) => { wallets = list; const select = get<HTMLSelectElement>("ens-web-wallet"), previous = select.value; select.replaceChildren(); for (const wallet of list) { const option = document.createElement("option"); option.value = wallet.id; option.textContent = wallet.name; select.append(option); } select.value = list.some(item => item.id === previous) ? previous : list[0]?.id ?? ""; if (controller && !controller.state().busy) selectWallet(); });
  }).catch(error => { if (!closed) { get("ens-availability").textContent = "Wallet registration is unavailable. Local drafts remain available."; failure(error); controls(); } });
  return { invalidate, close() { closed = true; generation++; controller?.close(); discovery?.close(); } };
}
