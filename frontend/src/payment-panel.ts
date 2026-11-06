import { PaymentClient, createSessionKey, type PaymentSessionSnapshot } from "@derpc/payments";
import type { PaymentTerms } from "@derpc/provider/discovery";
import type { DeRPCOperator } from "@derpc/provider";
import { formatEther, type Hex } from "viem";
import { textCell } from "./render.ts";
import { confirmOpenedSession, confirmSettlement, openTestSession, parseDeployment, refundTestSession, testDeposit, type EscrowDeployment, type FundedSession, type WalletProvider } from "./wallet-payments.ts";

export interface PaidOperator { id: string; name: string; payment: PaymentTerms; endpoint: DeRPCOperator }
interface SettlementReply {
  highestAmount?: string;
  settlement?: { state: string; transactionHash?: Hex; paid?: string; refunded?: string };
}
interface PendingDeposit {
  operator: PaidOperator;
  signer: ReturnType<typeof createSessionKey>;
  request: Omit<FundedSession, "sessionId" | "refundAfter">;
}
interface SessionRow {
  operator: PaidOperator;
  funded: FundedSession;
  snapshot?: PaymentSessionSnapshot;
  status: string;
  finalized: boolean;
  busy: boolean;
  transactionHash?: Hex;
}

/** The wallet is consulted only after an explicit payment action. No external RPC URL is used here. */
export function mountPaymentPanel(options: {
  payments: PaymentClient;
  settle: (operatorId: string, close: boolean) => Promise<SettlementReply>;
  onEnabledChange: (enabled: boolean) => void;
  onFunded: (operator?: PaidOperator) => void;
  wallet?: () => WalletProvider | undefined;
}) {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const enable = element<HTMLInputElement>("enable-payments");
  const controls = element<HTMLFieldSetElement>("payment-controls");
  const select = element<HTMLSelectElement>("payment-operator");
  const submit = element<HTMLButtonElement>("open-payment");
  const status = element("payment-status");
  const body = element("payment-sessions");
  const rows = new Map<string, SessionRow>();
  const pending = new Map<string, PendingDeposit>();
  const views = new WeakMap<SessionRow | PendingDeposit, {
    element: HTMLTableRowElement;
    cells: HTMLTableCellElement[];
    actions: HTMLTableCellElement;
    buttons: Map<string, HTMLButtonElement>;
  }>();
  let operators: PaidOperator[] = [];
  let deployment: EscrowDeployment | undefined;
  let opening = false;

  const wallet = () => {
    const provider = options.wallet?.() ?? (globalThis as { ethereum?: WalletProvider }).ethereum;
    if (!provider?.request) throw new Error("No wallet found. Open this page with an Ethereum wallet to use test payments.");
    return provider;
  };
  function message(text: string, bad = false) { status.textContent = text; status.className = bad ? "bad" : "muted"; }
  function terms() {
    const selected = operators.find(o => o.id === select.value);
    element("payment-terms").textContent = selected
      ? `${selected.payment.price} wei / verified read · test chain ${selected.payment.chainId} · payee ${selected.payment.payee} · escrow ${selected.payment.escrow}. ${selected.payment.recordsProven ? "Terms proven." : "Discovery terms unverified; test funds only."} Price stays fixed for this session.`
      : "No paid operator selected. Load ENS records and choose an operator with payment terms first.";
    submit.disabled = opening || !enable.checked || !selected || !deployment || options.payments.has(selected.id) || pending.has(selected.id) || !!rows.get(selected.id) && !rows.get(selected.id)!.finalized;
  }
  function register(operator: PaidOperator, signer: ReturnType<typeof createSessionKey>, funded: FundedSession) {
    rows.set(operator.id, { operator, funded, status: "Funded; ready for verified reads", finalized: false, busy: false });
    try { options.payments.addSession({
      operatorId: operator.id, chainId: funded.chainId, escrow: funded.escrow, sessionId: funded.sessionId,
      payer: funded.payer, payee: funded.payee, signer, deposit: funded.deposit, price: operator.payment.price,
      refundAfter: funded.refundAfter, creditWindow: 4, spendLimit: funded.deposit,
    }); } catch (error) {
      pending.delete(operator.id);
      const row = rows.get(operator.id)!;
      row.status = `Deposit confirmed; reads unavailable: ${errorText(error)}. Refund it in the funding wallet after the deadline.`;
      message(row.status, true); render(); terms(); return;
    }
    pending.delete(operator.id);
    message(`Session ${funded.sessionId} funded on test chain ${funded.chainId}. Deposit transaction ${funded.transactionHash}. Reads can now earn vouchers.`);
    options.onFunded(operator);
    render(); terms();
  }

  enable.addEventListener("change", () => {
    controls.disabled = !enable.checked;
    options.onEnabledChange(enable.checked);
    message(enable.checked ? "Import a verified test escrow deployment record, then fund a selected paid operator." : "Test payments are off. Paid reads are stopped; existing sessions can still settle or refund below.");
    terms();
  });
  select.addEventListener("change", terms);
  element<HTMLInputElement>("payment-manifest").addEventListener("change", async event => {
    deployment = undefined;
    try {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) { terms(); return; }
      if (file.size > 64 * 1024) throw new Error("The deployment record is too large (64 KiB maximum).");
      deployment = parseDeployment(JSON.parse(await file.text()));
      message(`Loaded ${deployment.name}: ${deployment.escrow}. This imported record is a trust input; the wallet checks that its code matches. Neither the record nor wallet receipts are light-client verified.`);
    } catch (error) { message(errorText(error), true); }
    terms();
  });
  element<HTMLFormElement>("payment-open-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (opening) return;
    const selected = operators.find(o => o.id === select.value);
    if (!enable.checked || !selected || !deployment) { message("Enable test payments, import a deployment record and choose a paid operator.", true); return; }
    if (options.payments.has(selected.id) || pending.has(selected.id) || !!rows.get(selected.id) && !rows.get(selected.id)!.finalized) { message("This operator already has a funded or pending session. Check it below before funding again.", true); return; }
    opening = true; submit.textContent = "Waiting for wallet…"; terms();
    try {
      const deposit = testDeposit(element<HTMLInputElement>("payment-deposit").value);
      if (deposit < selected.payment.price) throw new Error("The deposit must cover at least one verified read at this operator's price.");
      const signer = createSessionKey();
      const provider = wallet();
      const funded = await openTestSession({ wallet: provider, deployment, ...selected.payment, sessionKey: signer.address, deposit,
        onSubmitted: (transactionHash, payer) => {
          pending.set(selected.id, { operator: selected, signer, request: { payer, payee: selected.payment.payee, sessionKey: signer.address, escrow: selected.payment.escrow, chainId: selected.payment.chainId, deposit, transactionHash } });
          message(`Deposit submitted: ${transactionHash}. Waiting for its receipt; do not submit another deposit.`);
          submit.textContent = "Waiting for confirmation…"; render();
        },
      });
      register(selected, signer, funded);
    } catch (error) { message(errorText(error), true); }
    finally { opening = false; submit.textContent = "Open test session in wallet"; terms(); render(); }
  });

  async function settle(row: SessionRow, close: boolean) {
    if (row.busy) return;
    row.busy = true; render();
    try {
      const reply = await options.settle(row.operator.id, close);
      const settlement = reply.settlement;
      row.status = settlement ? `Operator settlement: ${settlement.state}` : "Final voucher acknowledged; no settlement receipt yet";
      row.transactionHash = settlement?.transactionHash;
      if (settlement?.state === "confirmed" && settlement.transactionHash) {
        const totals = await confirmSettlement(wallet(), row.funded, settlement.transactionHash, row.snapshot?.total ?? 0n);
        row.status = `Wallet receipt confirmed: ${formatEther(totals.paid)} test ETH settled, ${formatEther(totals.refunded)} ${totals.refundDeferred ? "credited for withdrawal; call escrow withdraw from the funding wallet" : "returned"} · ${settlement.transactionHash}`;
        row.finalized = true;
        if (options.payments.has(row.operator.id)) options.payments.removeSession(row.operator.id);
        options.onFunded();
      }
      message(row.status);
    } catch (error) { row.status = errorText(error); message(row.status, true); }
    finally { row.busy = false; render(); terms(); }
  }
  async function refund(row: SessionRow) {
    if (row.busy) return;
    row.busy = true; render();
    try {
      const result = await refundTestSession(wallet(), row.funded);
      row.status = `Wallet receipt confirmed: deposit ${result.refundDeferred ? "credited for withdrawal; call escrow withdraw from the funding wallet" : "refunded"} · ${result.transactionHash}`;
      row.finalized = true;
      if (options.payments.has(row.operator.id)) options.payments.removeSession(row.operator.id);
      options.onFunded();
      message(row.status);
    } catch (error) { row.status = errorText(error); message(row.status, true); }
    finally { row.busy = false; render(); terms(); }
  }
  function viewFor(item: SessionRow | PendingDeposit) {
    let view = views.get(item);
    if (!view) {
      const element = document.createElement("tr");
      const cells = Array.from({ length: 4 }, () => textCell(""));
      const actions = document.createElement("td"); actions.className = "row-actions";
      element.append(...cells, actions);
      view = { element, cells, actions, buttons: new Map() };
      views.set(item, view);
    }
    return view;
  }
  function updateRow(view: ReturnType<typeof viewFor>, values: string[], stateClass: string) {
    values.forEach((value, index) => {
      if (view.cells[index]!.textContent !== value) view.cells[index]!.textContent = value;
    });
    view.cells[3]!.className = stateClass;
  }
  function updateActions(view: ReturnType<typeof viewFor>, actions: { text: string; run: () => Promise<unknown>; disabled: boolean }[]) {
    for (const [text, button] of view.buttons) {
      if (!actions.some(action => action.text === text)) { button.remove(); view.buttons.delete(text); }
    }
    for (const action of actions) {
      let button = view.buttons.get(action.text);
      if (!button) {
        button = document.createElement("button"); button.type = "button"; button.textContent = action.text;
        button.addEventListener("click", () => void action.run());
        view.buttons.set(action.text, button); view.actions.append(button);
      }
      button.disabled = action.disabled;
    }
  }
  function render() {
    for (const snapshot of options.payments.snapshot()) {
      const row = rows.get(snapshot.operatorId);
      if (row) row.snapshot = snapshot;
    }
    const rendered: HTMLTableRowElement[] = [];
    for (const [id, item] of pending) {
      if (rows.has(id)) continue;
      const view = viewFor(item);
      updateActions(view, [{ text: "Check deposit", run: async () => {
        if (opening) return;
        opening = true; terms();
        try { register(item.operator, item.signer, await confirmOpenedSession({ ...item.request, wallet: wallet() })); }
        catch (error) { message(errorText(error), true); }
        finally { opening = false; terms(); render(); }
      }, disabled: opening }]);
      updateRow(view, [item.operator.name, "0", `0 / ${formatEther(item.request.deposit)} test ETH`, `Deposit pending: ${item.request.transactionHash}`], "warn");
      rendered.push(view.element);
    }
    for (const row of rows.values()) {
      const view = viewFor(row);
      const snapshot = row.snapshot;
      const actions: Parameters<typeof updateActions>[1] = [];
      if (!row.finalized) {
        actions.push({ text: "Close with operator", run: () => settle(row, true), disabled: row.busy || !!snapshot?.inFlight || !options.payments.has(row.operator.id) });
        actions.push({ text: "Check settlement", run: () => settle(row, false), disabled: row.busy || !options.payments.has(row.operator.id) });
        if (Date.now() / 1000 >= row.funded.refundAfter) actions.push({ text: "Refund in wallet", run: () => refund(row), disabled: row.busy || !!snapshot?.inFlight });
      }
      updateActions(view, actions);
      const state = row.finalized ? row.status : `${row.status} · ${snapshot?.status ?? "ready"} · refund after ${new Date(row.funded.refundAfter * 1000).toISOString()}`;
      updateRow(view, [`${row.operator.name} / ${row.funded.sessionId}`, String(snapshot?.verifiedReads ?? 0), `${formatEther(snapshot?.total ?? 0n)} / ${formatEther(row.funded.deposit)} test ETH`, state], row.finalized ? "ok" : "muted");
      rendered.push(view.element);
    }
    if (!rendered.length) {
      const row = document.createElement("tr"); const cell = textCell("No sessions opened.", "muted"); cell.colSpan = 5; row.append(cell); rendered.push(row);
    }
    // Keep existing rows and buttons attached: replacing them loses keyboard focus on every tick.
    for (const child of [...body.children]) if (!rendered.includes(child as HTMLTableRowElement)) child.remove();
    rendered.forEach((row, index) => {
      if (body.children[index] !== row) body.insertBefore(row, body.children[index] ?? null);
    });
  }
  const timer = setInterval(render, 1000);
  return {
    render,
    enabled: () => enable.checked,
    setOperators(next: PaidOperator[]) {
      const previous = select.value; operators = next;
      select.replaceChildren();
      const empty = document.createElement("option"); empty.value = ""; empty.textContent = next.length ? "Choose a paid operator" : "Choose a paid operator above first"; select.append(empty);
      for (const operator of next) { const option = document.createElement("option"); option.value = operator.id; option.textContent = operator.name; select.append(option); }
      if (next.some(o => o.id === previous)) select.value = previous;
      terms();
    },
    rejection(name: string) { element("payment-rejection").textContent = `${name}: proof rejected; no payment voucher was signed for that answer. Check each operator's signed total above.`; },
    dispose() { clearInterval(timer); },
  };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
