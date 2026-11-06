import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Hex } from "viem";
import { queryEscrowAbi } from "@derpc/payments";
import { confirmOpenedSession, confirmSettlement, openTestSession, parseDeployment, refundTestSession, testDeposit, type FundedSession, type WalletProvider } from "../src/wallet-payments.ts";

const escrow = `0x${"11".repeat(20)}` as Hex;
const payer = `0x${"22".repeat(20)}` as Hex;
const payee = `0x${"33".repeat(20)}` as Hex;
const sessionKey = `0x${"44".repeat(20)}` as Hex;
const transactionHash = `0x${"55".repeat(32)}` as Hex;
const code = "0x60006000";
const chainId = 11155111;
const manifest = { schemaVersion: 1, kind: "derpc-query-escrow", testPayments: true, chainId, name: "Sepolia", escrow, codeHash: keccak256(code), transactionHash, verification: { receipt: true, runtimeCode: true, creationInput: true } };
const session: FundedSession = { sessionId: 7n, payer, payee, sessionKey, escrow, chainId, deposit: 100n, refundAfter: 1, transactionHash };

function openedLog(overrides: { deposit?: bigint; key?: Hex } = {}) {
  return { address: escrow,
    topics: encodeEventTopics({ abi: queryEscrowAbi, eventName: "Opened", args: { sessionId: 7n, payer, operator: payee } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint64" }], [overrides.key ?? sessionKey, overrides.deposit ?? 100n, BigInt(Math.floor(Date.now() / 1000) + 3600)]),
  };
}
function wallet(logs: unknown[] = [openedLog()], onRequest?: (method: string, params?: unknown[]) => unknown): WalletProvider & { request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn(async ({ method, params }) => {
    const custom = onRequest?.(method, params);
    if (custom !== undefined) return custom;
    if (method === "eth_chainId") return toHex(chainId);
    if (method === "eth_requestAccounts") return [payer];
    if (method === "eth_getCode") return code;
    if (method === "eth_sendTransaction") return transactionHash;
    if (method === "eth_getTransactionReceipt") return { transactionHash, to: escrow, status: "0x1", logs };
    throw new Error(`Unexpected wallet method ${method}`);
  }) };
}
const open = (provider: WalletProvider) => openTestSession({ wallet: provider, deployment: parseDeployment(manifest), chainId, escrow, payee, sessionKey, deposit: 100n });

describe("test payment wallet boundary", () => {
  it("refuses mainnet, undeployed settings and excessive deposits", () => {
    expect(() => parseDeployment({ ...manifest, chainId: 1 })).toThrow("Real funds are disabled");
    expect(() => parseDeployment({ ...manifest, kind: "derpc-query-escrow-deployment-settings", escrow: null })).toThrow();
    expect(() => testDeposit("1.000000000000000001")).toThrow();
    expect(() => testDeposit("0")).toThrow();
    expect(testDeposit("0.001")).toBe(1_000_000_000_000_000n);
  });

  it("checks wallet runtime code before requesting accounts or sending a deposit", async () => {
    const provider = wallet([], method => method === "eth_getCode" ? "0x6001" : undefined);
    await expect(open(provider)).rejects.toThrow("code does not match");
    expect(provider.request.mock.calls.map(([request]) => request.method)).toEqual(["eth_chainId", "eth_getCode"]);
  });

  it("stops when account selection switches the network", async () => {
    let network = chainId;
    const provider = wallet([], method => {
      if (method === "eth_chainId") return toHex(network);
      if (method === "eth_requestAccounts") { network = 1; return [payer]; }
    });
    await expect(open(provider)).rejects.toThrow("Switch your wallet");
    expect(provider.request.mock.calls.some(([request]) => request.method === "eth_sendTransaction")).toBe(false);
  });

  it("binds the deposit to the test chain even if the wallet switches during approval", async () => {
    const provider = wallet([], (method, params) => {
      if (method === "eth_sendTransaction") {
        const request = params?.[0] as { chainId: string };
        expect(request.chainId).toBe(toHex(chainId));
        throw new Error("Wallet rejected transaction for a different selected chain");
      }
    });
    await expect(open(provider)).rejects.toThrow("different selected chain");
  });

  it("accepts only an Opened receipt matching the intended payer, key and deposit", async () => {
    const provider = wallet();
    const result = await open(provider);
    expect(result).toMatchObject({ sessionId: 7n, payer, payee, sessionKey, deposit: 100n });
    expect(provider.request).toHaveBeenCalledWith(expect.objectContaining({ method: "eth_sendTransaction", params: [expect.objectContaining({ chainId: toHex(chainId), value: "0x64" })] }));
    await expect(confirmOpenedSession({ ...session, wallet: wallet([openedLog({ deposit: 101n })]) })).rejects.toThrow("does not match");
    await expect(confirmOpenedSession({ ...session, wallet: wallet([openedLog({ key: payer })]) })).rejects.toThrow("does not match");
  });

  it("checks settlement amounts and distinguishes a deferred refund from transferred ETH", async () => {
    const closed = { address: escrow, topics: encodeEventTopics({ abi: queryEscrowAbi, eventName: "Closed", args: { sessionId: 7n } }), data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [20n, 80n]) };
    const deferred = { address: escrow, topics: encodeEventTopics({ abi: queryEscrowAbi, eventName: "WithdrawalDeferred", args: { recipient: payer } }), data: encodeAbiParameters([{ type: "uint256" }], [80n]) };
    await expect(confirmSettlement(wallet([closed, deferred]), session, transactionHash, 20n)).resolves.toEqual({ paid: 20n, refunded: 80n, refundDeferred: true });
    await expect(confirmSettlement(wallet([closed]), session, transactionHash, 19n)).rejects.toThrow("does not match");
  });

  it("rechecks and binds the refund chain, and waits for its matching event", async () => {
    const log = { address: escrow, topics: encodeEventTopics({ abi: queryEscrowAbi, eventName: "Refunded", args: { sessionId: 7n } }), data: encodeAbiParameters([{ type: "uint256" }], [100n]) };
    const provider = wallet([log]);
    await expect(refundTestSession(provider, session)).resolves.toEqual({ transactionHash, refundDeferred: false });
    expect(provider.request).toHaveBeenCalledWith({ method: "eth_sendTransaction", params: [expect.objectContaining({ chainId: toHex(chainId), from: payer })] });
    let network = chainId;
    const switched = wallet([], method => {
      if (method === "eth_chainId") return toHex(network);
      if (method === "eth_requestAccounts") { network = 1; return [payer]; }
    });
    await expect(refundTestSession(switched, session)).rejects.toThrow("Switch your wallet");
    expect(switched.request.mock.calls.some(([request]) => request.method === "eth_sendTransaction")).toBe(false);
  });
});
