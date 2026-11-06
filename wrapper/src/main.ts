import { readFileSync } from "node:fs";
import { createProxy, validateEndpointId, validateOperatorName, type Identity } from "./proxy.ts";
import { serve } from "./server.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function port(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw new Error(`${name} must be a port from 1 to 65535`);
  return Number(value);
}

const ens = required("DERPC_ENS_NAME");
const signer = required("DERPC_SIGNER");
validateOperatorName(ens);
if (!/^0x[\da-fA-F]{40}$/.test(signer)) throw new Error("expected signer address");
const endpointId = process.env.DERPC_ENDPOINT_ID || undefined;
if (endpointId !== undefined) {
  validateEndpointId(endpointId);
  if (process.env.DERPC_PAYMENT_ESCROW) throw new Error("multiple-endpoint operators are free-only; remove payment configuration before starting this wrapper");
}
const identity: Identity = {
  ens, signer, chains: [1], version: "1",
  ...(endpointId !== undefined ? { endpointId } : {}),
  service: process.env.DERPC_DEMO_PROXY === "true" ? "demo-proxy" : "node",
};
const options = { executionUrl: required("DERPC_EXECUTION_URL"), beaconUrl: required("DERPC_BEACON_URL"), identity };
const publicPort = port("DERPC_PORT", 8787);
const personalPort = port("DERPC_PERSONAL_PORT", 8788);
if (process.env.DERPC_PERSONAL_TOKEN_FILE && personalPort === publicPort) throw new Error("public and personal listener ports must differ");
let payments: Awaited<ReturnType<typeof import("./payment.ts")["createPaymentController"]>> | undefined;
let paymentStore: Awaited<ReturnType<typeof import("./payment-store.ts")["openFilePaymentStore"]>> | undefined;
let settlementTimer: ReturnType<typeof setInterval> | undefined;
if (process.env.DERPC_PAYMENT_ESCROW) {
  const { createPaymentController } = await import("./payment.ts");
  const { openFilePaymentStore } = await import("./payment-store.ts");
  const { createPaymentChain } = await import("./payment-chain.ts");
  const chainId = Number(required("DERPC_PAYMENT_CHAIN_ID"));
  const escrow = required("DERPC_PAYMENT_ESCROW") as `0x${string}`;
  if (!/^0x[\da-fA-F]{40}$/.test(escrow)) throw new Error("invalid payment escrow address");
  const privateKey = readFileSync(required("DERPC_SETTLEMENT_KEY_FILE"), "utf8").trim() as `0x${string}`;
  if (!/^0x[\da-fA-F]{64}$/.test(privateKey)) throw new Error("settlement key file must hold one hex private key");
  paymentStore = await openFilePaymentStore(required("DERPC_PAYMENT_STATE_DIR"));
  try {
    const { chain, operator } = await createPaymentChain({ rpcUrl: required("DERPC_PAYMENT_RPC_URL"), chainId, escrow, privateKey, store: paymentStore, confirmations: Number(process.env.DERPC_PAYMENT_CONFIRMATIONS ?? "2") });
    payments = createPaymentController({ chainId, escrow, operator, price: BigInt(required("DERPC_PRICE_WEI")), chain, store: paymentStore });
    let polling = false;
    const tick = async () => {
      if (polling) return;
      polling = true;
      try {
        const results = await payments!.tick();
        for (const result of results) if (result.settlement.state === "failed" || result.settlement.state === "expired" || result.settlement.error) console.error(`Settlement needs attention: ${result.settlement.error ?? result.settlement.state}`);
      } catch { console.error("Settlement polling failed; operator intervention may be needed before refund deadlines"); }
      finally { polling = false; }
    };
    await tick();
    settlementTimer = setInterval(() => { void tick(); }, 15_000);
    settlementTimer.unref();
    console.log(`Test payments enabled on chain ${chainId}; payee ${operator}`);
  } catch (error) { await paymentStore.close(); throw error; }
}
const servers = [serve(createProxy({ ...options, payments }), publicPort)];
if (process.env.DERPC_PERSONAL_TOKEN_FILE) {
  const personalToken = readFileSync(process.env.DERPC_PERSONAL_TOKEN_FILE, "utf8").trim();
  servers.push(serve(createProxy({ ...options, personalToken }), personalPort));
}
console.log(`DeRPC wrapper listening on loopback (${identity.service}); personal mode ${servers.length === 2 ? "enabled" : "disabled"}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  if (settlementTimer) clearInterval(settlementTimer);
  for (const server of servers) { server.close(); server.closeAllConnections(); }
  // Existing journal operations finish before releasing the writer lock on normal shutdown.
  if (paymentStore) void payments?.drain().finally(() => paymentStore!.close());
});
