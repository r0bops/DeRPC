// Records real mainnet eth_getProof / eth_getCode responses at one block, plus that block's header,
// as fixtures for the proof verifier tests. Run from provider/: node test/fixtures/record-proofs.mjs [rpcUrl]
// Recorded with a direct connection on the developer's machine; it is test data, not app traffic.
import { writeFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3";

const RPC = process.argv[2] ?? "https://eth.drpc.org";
const OUT = new URL("./mainnet-proofs.json", import.meta.url);

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WETH_BALANCE_SLOT = 3n; // WETH9: name(0) symbol(1) decimals(2) balanceOf(3) allowance(4)
const HOLDER = "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc"; // Uniswap V2 USDC/WETH pair: public, holds WETH
const NO_WETH = "0x" + "5e".repeat(20); // no account and no WETH: absent from the storage trie too
const NONEXISTENT = NO_WETH; // an address with no account in state (absence proof)

const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const mappingSlot = (address, slot) => "0x" + Buffer.from(keccak_256(Buffer.from(pad(address) + pad(slot.toString(16)), "hex"))).toString("hex");

async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

const finalized = await rpc("eth_getBlockByNumber", ["finalized", false]);
const block = finalized.number;
const holderSlot = mappingSlot(HOLDER, WETH_BALANCE_SLOT);
const noWethSlot = mappingSlot(NO_WETH, WETH_BALANCE_SLOT);

const fixture = {
  rpc: RPC,
  capturedAt: Date.now(),
  block: { number: Number(block), hash: finalized.hash, stateRoot: finalized.stateRoot },
  inputs: { WETH, WETH_BALANCE_SLOT: Number(WETH_BALANCE_SLOT), HOLDER, NO_WETH, NONEXISTENT, holderSlot, noWethSlot },
  responses: {
    holderAccount: await rpc("eth_getProof", [HOLDER, [], block]),
    wethWithSlots: await rpc("eth_getProof", [WETH, [holderSlot, noWethSlot], block]),
    nonexistentAccount: await rpc("eth_getProof", [NONEXISTENT, [], block]),
    wethCode: await rpc("eth_getCode", [WETH, block]),
  },
  // Independent reference values via ordinary RPC calls at the same block (not used by the verifier).
  reference: {
    holderBalance: await rpc("eth_getBalance", [HOLDER, block]),
    holderNonce: await rpc("eth_getTransactionCount", [HOLDER, block]),
    holderWethBalanceOf: await rpc("eth_call", [{ to: WETH, data: "0x70a08231" + pad(HOLDER) }, block]),
  },
};
writeFileSync(OUT, JSON.stringify(fixture, null, 1) + "\n");
console.log(`wrote ${OUT.pathname} at block ${Number(block)} (state root ${finalized.stateRoot})`);
console.log(`  holder ${HOLDER}: balance ${BigInt(fixture.reference.holderBalance)} wei, nonce ${BigInt(fixture.reference.holderNonce)}, WETH ${BigInt(fixture.reference.holderWethBalanceOf)}`);
console.log(`  nonexistent account proof nodes: ${fixture.responses.nonexistentAccount.accountProof.length}`);
