import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentClient } from "@derpc/payments";
import page from "../index.html?raw";
import { mountPaymentPanel } from "../src/payment-panel.ts";
import { openTestSession, confirmSettlement, confirmOpenedSession } from "../src/wallet-payments.ts";
import type { Hex } from "viem";

vi.mock("../src/wallet-payments.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/wallet-payments.ts")>(),
  openTestSession: vi.fn(),
  confirmSettlement: vi.fn(),
  confirmOpenedSession: vi.fn(),
}));

const address = (byte: string) => `0x${byte.repeat(20)}` as Hex;
const tx = `0x${"aa".repeat(32)}` as Hex;
const manifest = { schemaVersion: 1, kind: "derpc-query-escrow", testPayments: true, chainId: 11155111, name: "Test", escrow: address("11"), codeHash: tx, transactionHash: tx, verification: { receipt: true, creationInput: true, runtimeCode: true } };
const operator = { id: "paid.derpc.eth", name: "paid.derpc.eth", endpoint: { id: "paid.derpc.eth", ens: "paid.derpc.eth", url: "https://rpc.example/", priority: 0 }, payment: { price: 10n, payee: address("22"), escrow: address("11"), chainId: 11155111, payeeProven: false, recordsProven: false } };
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sessionButton = (text: string) => [...el("payment-sessions").querySelectorAll("button")].find(button => button.textContent === text)!;
let panel: ReturnType<typeof mountPaymentPanel> | undefined;
afterEach(() => { panel?.dispose(); panel = undefined; vi.useRealTimers(); vi.clearAllMocks(); document.body.replaceChildren(); });

describe("payment panel", () => {
  it("recovers a pending deposit after deselection without sending another deposit or enabling payments", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = page.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");
    const payments = new PaymentClient({ onChange: () => panel?.render() });
    const onFunded = vi.fn();
    panel = mountPaymentPanel({ payments, wallet: () => ({ request: vi.fn() }), settle: vi.fn(), onEnabledChange: vi.fn(), onFunded });
    panel.setOperators([operator]);
    el<HTMLInputElement>("enable-payments").checked = true;
    el("enable-payments").dispatchEvent(new Event("change"));
    Object.defineProperty(el("payment-manifest"), "files", { value: [{ size: 1000, text: async () => JSON.stringify(manifest) }], configurable: true });
    el("payment-manifest").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(el("payment-status").textContent).toContain("trust input"));
    el<HTMLSelectElement>("payment-operator").value = operator.id;
    el("payment-operator").dispatchEvent(new Event("change"));
    vi.mocked(openTestSession).mockImplementation(async options => {
      options.onSubmitted?.(tx, address("33"));
      throw new Error("Receipt temporarily unavailable");
    });
    el("payment-open-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(el("payment-status").textContent).toContain("Receipt temporarily unavailable"));
    expect(el<HTMLButtonElement>("open-payment").disabled).toBe(true);
    el<HTMLInputElement>("enable-payments").checked = false;
    el("enable-payments").dispatchEvent(new Event("change"));
    panel.setOperators([]);
    const checkDeposit = sessionButton("Check deposit");
    checkDeposit.focus();
    await vi.advanceTimersByTimeAsync(2100);
    expect(sessionButton("Check deposit")).toBe(checkDeposit);
    expect(document.activeElement).toBe(checkDeposit);
    vi.mocked(confirmOpenedSession).mockImplementation(async ({ wallet: _wallet, ...request }) => ({ ...request, sessionId: 8n, refundAfter: Math.floor(Date.now() / 1000) + 3600 }));
    checkDeposit.click();
    await vi.waitFor(() => expect(payments.has(operator.id)).toBe(true));
    expect(openTestSession).toHaveBeenCalledTimes(1);
    expect(onFunded).toHaveBeenCalledWith(operator);
    expect(panel.enabled()).toBe(false);
    expect(el<HTMLFieldSetElement>("payment-controls").disabled).toBe(true);

    const checkSettlement = sessionButton("Check settlement");
    checkSettlement.focus();
    expect(sessionButton("Refund in wallet")).toBeUndefined();
    vi.setSystemTime(Date.now() + 3600_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sessionButton("Check settlement")).toBe(checkSettlement);
    expect(document.activeElement).toBe(checkSettlement);
    const refund = sessionButton("Refund in wallet");
    expect(refund.disabled).toBe(false);
    refund.focus();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sessionButton("Refund in wallet")).toBe(refund);
    expect(document.activeElement).toBe(refund);
  });

  it("requests no wallet on enable, counts only verified attempts, and waits for a receipt before calling settlement confirmed", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = page.match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");
    const payments = new PaymentClient({ onChange: () => panel?.render() });
    const wallet = vi.fn(() => ({ request: vi.fn() }));
    const settle = vi.fn().mockResolvedValue({ settlement: { state: "pending", transactionHash: tx } });
    const onFunded = vi.fn();
    panel = mountPaymentPanel({ payments, wallet, settle, onEnabledChange: vi.fn(), onFunded });
    panel.setOperators([operator]);
    el<HTMLInputElement>("enable-payments").checked = true;
    el("enable-payments").dispatchEvent(new Event("change"));
    expect(wallet).not.toHaveBeenCalled();
    expect(el<HTMLFieldSetElement>("payment-controls").disabled).toBe(false);
    const file = { size: 1000, text: async () => JSON.stringify(manifest) };
    Object.defineProperty(el("payment-manifest"), "files", { value: [file], configurable: true });
    el("payment-manifest").dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(el("payment-status").textContent).toContain("trust input"));
    el<HTMLSelectElement>("payment-operator").value = operator.id;
    el("payment-operator").dispatchEvent(new Event("change"));
    vi.mocked(openTestSession).mockImplementation(async options => ({ sessionId: 7n, payer: address("33"), payee: operator.payment.payee, sessionKey: options.sessionKey, escrow: operator.payment.escrow, chainId: operator.payment.chainId, deposit: options.deposit, refundAfter: Math.floor(Date.now() / 1000) + 3600, transactionHash: tx }));
    el("payment-open-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(payments.has(operator.id)).toBe(true));
    expect(onFunded).toHaveBeenCalledWith(operator);

    const close = sessionButton("Close with operator");
    close.focus();
    await vi.advanceTimersByTimeAsync(2100);
    expect(sessionButton("Close with operator")).toBe(close);
    expect(document.activeElement).toBe(close);
    const checkSettlement = sessionButton("Check settlement");
    checkSettlement.focus();

    const rejected = await payments.begin(operator.id, "proof");
    rejected.failed();
    panel.rejection(operator.name);
    expect(el("payment-rejection").textContent).toContain("no payment voucher was signed");
    expect(payments.snapshot()[0]?.total).toBe(0n);
    expect(el("payment-sessions").querySelectorAll("tr td")[1]?.textContent).toBe("0");
    const accepted = await payments.begin(operator.id, "proof");
    await accepted.verified();
    expect(el("payment-sessions").querySelectorAll("tr td")[1]?.textContent).toBe("1");
    expect(payments.snapshot()[0]?.total).toBe(10n);
    expect(sessionButton("Check settlement")).toBe(checkSettlement);
    expect(document.activeElement).toBe(checkSettlement);
    expect(sessionButton("Close with operator")).toBe(close);
    expect(close.disabled).toBe(false);

    const click = (text: string) => sessionButton(text).click();
    click("Close with operator");
    await vi.waitFor(() => expect(el("payment-sessions").textContent).toContain("Operator settlement: pending"));
    expect(confirmSettlement).not.toHaveBeenCalled();
    expect(payments.has(operator.id)).toBe(true);
    settle.mockResolvedValue({ settlement: { state: "confirmed", transactionHash: tx } });
    vi.mocked(confirmSettlement).mockResolvedValue({ paid: 10n, refunded: 999999999999990n, refundDeferred: true });
    click("Check settlement");
    await vi.waitFor(() => expect(el("payment-sessions").textContent).toContain("credited for withdrawal"));
    expect(confirmSettlement).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: 7n }), tx, 10n);
    expect(payments.has(operator.id)).toBe(false);
    expect(el("payment-sessions").querySelectorAll("tr td")[1]?.textContent).toBe("1");
  });
});
