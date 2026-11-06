import { keccak256, parseAbi, stringToHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const queryEscrowAbi = parseAbi([
  "function SESSION_DURATION() view returns (uint64)",
  "function nextSessionId() view returns (uint256)",
  "function sessions(uint256) view returns (address payer,address operator,address sessionKey,uint256 deposit,uint64 refundAfter,bool closed)",
  "function open(address operator,address sessionKey) payable returns (uint256)",
  "function topUp(uint256 sessionId) payable",
  "function close(uint256 sessionId,uint256 amount,bytes signature)",
  "function refund(uint256 sessionId)",
  "function withdraw(address recipient)",
  "function pendingWithdrawals(address recipient) view returns (uint256)",
  "function voucherDigest(uint256 sessionId,uint256 amount) view returns (bytes32)",
  "event Opened(uint256 indexed sessionId,address indexed payer,address indexed operator,address sessionKey,uint256 deposit,uint64 refundAfter)",
  "event ToppedUp(uint256 indexed sessionId,uint256 deposit)",
  "event Closed(uint256 indexed sessionId,uint256 paid,uint256 refunded)",
  "event Refunded(uint256 indexed sessionId,uint256 amount)",
  "event WithdrawalDeferred(address indexed recipient,uint256 amount)",
]);

export type ReadKind = "proof" | "code" | "call";
export interface PaymentDomain { chainId: number; escrow: Address }
export interface SignedVoucher { sessionId: bigint; amount: bigint; signature: Hex }
export interface ReadAuthorization { sessionId: bigint; readId: Hex; kind: ReadKind; price: bigint; deadline: number }

export function paymentDomain({ chainId, escrow }: PaymentDomain) {
  return { name: "DeRPC Query Escrow", version: "1", chainId, verifyingContract: escrow } as const;
}

export function voucherTypedData(domain: PaymentDomain, sessionId: bigint, amount: bigint) {
  return {
    domain: paymentDomain(domain),
    types: { Voucher: [{ name: "sessionId", type: "uint256" }, { name: "amount", type: "uint256" }] },
    primaryType: "Voucher",
    message: { sessionId, amount },
  } as const;
}

/** Authenticates a bounded request; this type can never be redeemed by QueryEscrow.close. */
export function readAuthorizationTypedData(domain: PaymentDomain, authorization: ReadAuthorization) {
  return {
    domain: paymentDomain(domain),
    types: { ReadAuthorization: [
      { name: "sessionId", type: "uint256" }, { name: "readId", type: "bytes32" },
      { name: "kindHash", type: "bytes32" }, { name: "price", type: "uint256" },
      { name: "deadline", type: "uint64" },
    ] },
    primaryType: "ReadAuthorization",
    message: { sessionId: authorization.sessionId, readId: authorization.readId, kindHash: keccak256(stringToHex(authorization.kind)), price: authorization.price, deadline: BigInt(authorization.deadline) },
  } as const;
}

/** A public/replayed cumulative voucher alone never authorizes the wrapper to stop a session. */
export function closeAuthorizationTypedData(domain: PaymentDomain, authorization: { sessionId: bigint; amount: bigint; deadline: number }) {
  return {
    domain: paymentDomain(domain),
    types: { CloseAuthorization: [
      { name: "sessionId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "deadline", type: "uint64" },
    ] },
    primaryType: "CloseAuthorization",
    message: { sessionId: authorization.sessionId, amount: authorization.amount, deadline: BigInt(authorization.deadline) },
  } as const;
}

/** Keep the returned account in host memory only; do not serialize it or give it to a worker. */
export function createSessionKey() { return privateKeyToAccount(generatePrivateKey()); }

export const TEST_PAYMENT_CHAIN_IDS = [11155111, 560048, 31337, 1337] as const;

/** Test funds only until chain, escrow runtime, payee and operational/legal review gates are complete. */
export function assertTestPaymentChain(chainId: number): void {
  if (!(TEST_PAYMENT_CHAIN_IDS as readonly number[]).includes(chainId)) throw new Error("real-fund payments are disabled; select a supported test chain");
}
