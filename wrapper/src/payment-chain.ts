import { createPublicClient, encodeFunctionData, http, keccak256, parseTransaction, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertTestPaymentChain, queryEscrowAbi } from "@derpc/payments";
import type { PaymentChain } from "./payment.ts";
import type { PaymentStore } from "./payment-store.ts";

/** Operator infrastructure traffic to its own settlement-chain node, never a client RPC fallback. */
export async function createPaymentChain(options: {
  rpcUrl: string;
  chainId: number;
  escrow: Address;
  privateKey: Hex;
  store: PaymentStore;
  confirmations?: number;
}): Promise<{ chain: PaymentChain; operator: Address }> {
  assertTestPaymentChain(options.chainId);
  const rpcUrl = new URL(options.rpcUrl);
  if (!["http:", "https:"].includes(rpcUrl.protocol) || rpcUrl.username || rpcUrl.password || rpcUrl.hash) throw new Error("invalid payment node URL");
  const confirmations = options.confirmations ?? 2;
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 64) throw new Error("invalid payment confirmations");
  const account = privateKeyToAccount(options.privateKey);
  const client = createPublicClient({ transport: http(options.rpcUrl, { timeout: 15_000, retryCount: 0 }) });
  if (await client.getChainId() !== options.chainId) throw new Error("payment node is on the wrong chain");
  const code = await client.getCode({ address: options.escrow });
  if (!code || code === "0x") throw new Error("payment escrow has no deployed code");
  const chain: PaymentChain = {
    async session(id) {
      const head = await client.getBlock({ blockTag: "latest" });
      if (Math.abs(Date.now() / 1000 - Number(head.timestamp)) > 180) throw new Error("payment node head is stale");
      const blockNumber = head.number >= BigInt(confirmations - 1) ? head.number - BigInt(confirmations - 1) : 0n;
      const s = await client.readContract({ address: options.escrow, abi: queryEscrowAbi, functionName: "sessions", args: [id], blockNumber });
      return { payer: s[0], operator: s[1], sessionKey: s[2], deposit: s[3], refundAfter: Number(s[4]), closed: s[5] };
    },
    async prepareClose(id, amount, signature) {
      let nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
      // Expiry stops the escrow claim, not the account nonce reservation. An expired close
      // may still need to be mined (and revert) before later settlements can make progress.
      for (const session of await options.store.list()) {
        const signed = session.settlement.serializedTransaction;
        if (signed && ["pending", "submitting", "expired"].includes(session.settlement.state)) {
          const transaction = parseTransaction(signed);
          if (transaction.chainId !== options.chainId) throw new Error("journal contains a transaction from another payment chain");
          nonce = Math.max(nonce, Number(transaction.nonce ?? 0) + 1);
        }
      }
      const data = encodeFunctionData({ abi: queryEscrowAbi, functionName: "close", args: [id, amount, signature] });
      const gas = await client.estimateGas({ account, to: options.escrow, data });
      const fees = await client.estimateFeesPerGas();
      const serializedTransaction = await account.signTransaction({ type: "eip1559", chainId: options.chainId, nonce, to: options.escrow, data, gas: gas + gas / 5n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      return { transactionHash: keccak256(serializedTransaction), serializedTransaction };
    },
    async broadcast(serializedTransaction) { await client.sendRawTransaction({ serializedTransaction }); },
    async receipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        const head = await client.getBlockNumber();
        if (head < receipt.blockNumber + BigInt(confirmations - 1)) return "pending";
        return receipt.status === "success" ? "success" : "reverted";
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return "pending";
        throw error;
      }
    },
  };
  return { chain, operator: account.address };
}
