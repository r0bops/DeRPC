// Records a real mainnet eth_getProof for the tor-js worker specifier's storage slot 1 (workerHash in
// the reference WorkerSpecifier layout), plus the block's state root, for the worker-pin check tests.
// Run from provider/: node test/fixtures/record-worker-pin.mjs [rpcUrl]
// Recorded with a direct connection on the developer's machine; it is test data, not app traffic.
import { writeFileSync } from "node:fs";

const RPC = process.argv[2] ?? "https://eth.drpc.org";
const OUT = new URL("./mainnet-worker-pin.json", import.meta.url);
const SPECIFIER = "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e"; // tor-js
const SLOT_WORKER_HASH = "0x1";

async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

const finalized = await rpc("eth_getBlockByNumber", ["finalized", false]);
const fixture = {
  rpc: RPC,
  capturedAt: Date.now(),
  block: { number: Number(finalized.number), hash: finalized.hash, stateRoot: finalized.stateRoot },
  specifier: SPECIFIER,
  slot: SLOT_WORKER_HASH,
  proof: await rpc("eth_getProof", [SPECIFIER, [SLOT_WORKER_HASH], finalized.number]),
  // Independent reference: the public workerHash() getter at the same block.
  reference: { workerHash: await rpc("eth_call", [{ to: SPECIFIER, data: "0x3898587d" }, finalized.number]) },
};
writeFileSync(OUT, JSON.stringify(fixture, null, 1) + "\n");
console.log(`wrote ${OUT.pathname} at block ${fixture.block.number}`);
console.log(`  slot 1 (proof claim) = ${fixture.proof.storageProof[0].value}`);
console.log(`  workerHash() (eth_call) = ${fixture.reference.workerHash}`);
