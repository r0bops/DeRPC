import { decodeEventLog, encodeFunctionData, isAddress, keccak256, parseEther, toHex, type Hex } from "viem";
import { queryEscrowAbi, TEST_PAYMENT_CHAIN_IDS } from "@derpc/payments";

export interface WalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface EscrowDeployment {
  schemaVersion: 1;
  kind: "derpc-query-escrow";
  testPayments: true;
  chainId: number;
  name: string;
  escrow: Hex;
  codeHash: Hex;
  transactionHash: Hex;
}

export interface FundedSession {
  sessionId: bigint;
  payer: Hex;
  payee: Hex;
  sessionKey: Hex;
  escrow: Hex;
  chainId: number;
  deposit: bigint;
  refundAfter: number;
  transactionHash: Hex;
}

const TEST_CHAINS = new Set<number>(TEST_PAYMENT_CHAIN_IDS);
const hash = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-fA-F]{64}$/.test(value);
const address = (value: unknown): value is Hex => typeof value === "string" && isAddress(value) && BigInt(value) !== 0n;

export function parseDeployment(input: unknown): EscrowDeployment {
  if (!input || typeof input !== "object") throw new Error("Choose a verified test escrow deployment record.");
  const value = input as Record<string, unknown>;
  const verification = value.verification as Record<string, unknown> | undefined;
  if (value.schemaVersion !== 1 || value.kind !== "derpc-query-escrow" || value.testPayments !== true || !TEST_CHAINS.has(Number(value.chainId)) || typeof value.chainId !== "number" || !address(value.escrow) || !hash(value.codeHash) || !hash(value.transactionHash) || !verification || verification.receipt !== true || verification.runtimeCode !== true || verification.creationInput !== true) {
    throw new Error("The record must describe a receipt-verified escrow on Hoodi, Sepolia or a local test chain. Real funds are disabled.");
  }
  return { schemaVersion: 1, kind: "derpc-query-escrow", testPayments: true, chainId: value.chainId, name: typeof value.name === "string" ? value.name.slice(0, 100) : `Test chain ${value.chainId}`, escrow: value.escrow, codeHash: value.codeHash, transactionHash: value.transactionHash };
}

export function testDeposit(input: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(input.trim())) throw new Error("Enter a positive test ETH amount with at most 18 decimal places.");
  const amount = parseEther(input.trim());
  if (amount <= 0n || amount > parseEther("1")) throw new Error("The demo accepts a deposit above zero and no more than 1 test ETH per session.");
  return amount;
}

async function chain(wallet: WalletProvider, expected: number): Promise<void> {
  const actual = await wallet.request({ method: "eth_chainId" });
  if (typeof actual !== "string" || BigInt(actual) !== BigInt(expected)) throw new Error(`Switch your wallet to test chain ${expected}, then try again.`);
}

async function confirmedReceipt(wallet: WalletProvider, transactionHash: Hex, escrow: Hex, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await wallet.request({ method: "eth_getTransactionReceipt", params: [transactionHash] });
    if (value && typeof value === "object") {
      const receipt = value as Record<string, unknown>;
      if (receipt.transactionHash !== transactionHash || typeof receipt.to !== "string" || receipt.to.toLowerCase() !== escrow.toLowerCase() || receipt.status !== "0x1") throw new Error("The wallet reported a failed or mismatched escrow transaction.");
      return receipt;
    }
    if (Date.now() >= deadline) throw new Error(`Transaction ${transactionHash} is still pending. Check it in your wallet before submitting another deposit.`);
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}

function escrowEvent(receipt: Record<string, unknown>, escrow: Hex, eventName: string): Record<string, unknown> {
  if (!Array.isArray(receipt.logs)) throw new Error("The transaction has no escrow event.");
  for (const entry of receipt.logs) {
    if (!entry || typeof entry.address !== "string" || entry.address.toLowerCase() !== escrow.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: queryEscrowAbi, data: entry.data, topics: entry.topics });
      if (event.eventName === eventName) return event.args as unknown as Record<string, unknown>;
    } catch { /* unrelated log */ }
  }
  throw new Error(`The transaction has no matching ${eventName} event.`);
}

/** Wallet traffic is explicit and separate from the mainnet read provider; test funds only. */
export async function openTestSession(options: {
  wallet: WalletProvider;
  deployment: EscrowDeployment;
  payee: Hex;
  chainId: number;
  escrow: Hex;
  sessionKey: Hex;
  deposit: bigint;
  onSubmitted?: (hash: Hex, payer: Hex) => void;
}): Promise<FundedSession> {
  const { wallet, deployment, payee, sessionKey, deposit } = options;
  if (!TEST_CHAINS.has(options.chainId) || options.chainId !== deployment.chainId || options.escrow.toLowerCase() !== deployment.escrow.toLowerCase()) throw new Error("The operator's payment terms do not match the imported test escrow deployment.");
  if (!address(payee) || !address(sessionKey) || deposit <= 0n || deposit > parseEther("1")) throw new Error("Invalid session deposit or addresses.");
  await chain(wallet, deployment.chainId);
  const code = await wallet.request({ method: "eth_getCode", params: [deployment.escrow, "latest"] });
  if (typeof code !== "string" || !/^0x(?:[\da-fA-F]{2})+$/.test(code) || keccak256(code as Hex).toLowerCase() !== deployment.codeHash.toLowerCase()) throw new Error("The wallet's escrow code does not match the deployment record. No deposit was sent.");
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  const payer = Array.isArray(accounts) ? accounts[0] : undefined;
  if (!address(payer)) throw new Error("Connect a wallet account to fund the test session.");
  await chain(wallet, deployment.chainId); // account selection can change wallet network
  const transactionHash = await wallet.request({ method: "eth_sendTransaction", params: [{ chainId: toHex(deployment.chainId), from: payer, to: deployment.escrow, value: toHex(deposit), data: encodeFunctionData({ abi: queryEscrowAbi, functionName: "open", args: [payee, sessionKey] }) }] });
  if (!hash(transactionHash)) throw new Error("The wallet did not return a transaction hash.");
  options.onSubmitted?.(transactionHash, payer);
  return confirmOpenedSession({ wallet, payer, payee, sessionKey, escrow: deployment.escrow, chainId: deployment.chainId, deposit, transactionHash });
}

export async function confirmOpenedSession(options: Omit<FundedSession, "sessionId" | "refundAfter"> & { wallet: WalletProvider }): Promise<FundedSession> {
  const { wallet, payer, payee, sessionKey, escrow, chainId, deposit, transactionHash } = options;
  await chain(wallet, chainId);
  const receipt = await confirmedReceipt(wallet, transactionHash, escrow);
  const event = escrowEvent(receipt, escrow, "Opened");
  if (typeof event.payer !== "string" || event.payer.toLowerCase() !== payer.toLowerCase() || typeof event.operator !== "string" || event.operator.toLowerCase() !== payee.toLowerCase() || typeof event.sessionKey !== "string" || event.sessionKey.toLowerCase() !== sessionKey.toLowerCase() || event.deposit !== deposit || typeof event.sessionId !== "bigint" || !Number.isSafeInteger(Number(event.refundAfter))) throw new Error("The deposit event does not match this session. Check the transaction in your wallet.");
  return { sessionId: event.sessionId, payer, payee, sessionKey, escrow, chainId, deposit, refundAfter: Number(event.refundAfter), transactionHash };
}

function deferredRefund(receipt: Record<string, unknown>, session: FundedSession): boolean {
  if (!Array.isArray(receipt.logs)) return false;
  return receipt.logs.some(entry => {
    if (typeof entry?.address !== "string" || entry.address.toLowerCase() !== session.escrow.toLowerCase()) return false;
    try {
      const event = decodeEventLog({ abi: queryEscrowAbi, data: entry.data, topics: entry.topics });
      return event.eventName === "WithdrawalDeferred" && event.args.recipient.toLowerCase() === session.payer.toLowerCase();
    } catch { return false; }
  });
}

export async function confirmSettlement(wallet: WalletProvider, session: FundedSession, transactionHash: Hex, authorized: bigint): Promise<{ paid: bigint; refunded: bigint; refundDeferred: boolean }> {
  await chain(wallet, session.chainId);
  const receipt = await confirmedReceipt(wallet, transactionHash, session.escrow, 20_000);
  const event = escrowEvent(receipt, session.escrow, "Closed");
  if (event.sessionId !== session.sessionId || typeof event.paid !== "bigint" || event.paid > authorized || typeof event.refunded !== "bigint" || event.paid + event.refunded !== session.deposit) throw new Error("The settlement receipt does not match the authorized session.");
  return { paid: event.paid, refunded: event.refunded, refundDeferred: deferredRefund(receipt, session) };
}

export async function refundTestSession(wallet: WalletProvider, session: FundedSession): Promise<{ transactionHash: Hex; refundDeferred: boolean }> {
  if (Date.now() / 1000 < session.refundAfter) throw new Error("The refund deadline has not arrived.");
  await chain(wallet, session.chainId);
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || accounts[0].toLowerCase() !== session.payer.toLowerCase()) throw new Error("Connect the wallet that funded this session.");
  await chain(wallet, session.chainId);
  const tx = await wallet.request({ method: "eth_sendTransaction", params: [{ chainId: toHex(session.chainId), from: session.payer, to: session.escrow, data: encodeFunctionData({ abi: queryEscrowAbi, functionName: "refund", args: [session.sessionId] }) }] });
  if (!hash(tx)) throw new Error("The wallet did not return a transaction hash.");
  const receipt = await confirmedReceipt(wallet, tx, session.escrow);
  const event = escrowEvent(receipt, session.escrow, "Refunded");
  if (event.sessionId !== session.sessionId || event.amount !== session.deposit) throw new Error("The refund event does not match this session.");
  return { transactionHash: tx, refundDeferred: deferredRefund(receipt, session) };
}
