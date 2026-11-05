/**
 * Pinned mainnet configuration. These values are a trust decision (see specs/CONTEXT.md §4):
 * they were read from the worker specifier contracts on Nov 5, 2026 (block 26349613, two RPCs
 * agreed) without a proof. They become trusted only once P2 proves the specifier's storage slot 1
 * against a light-client-verified state root, through the worker.
 */

export interface WorkerPin {
  /** Human-readable name of the anonymity network. */
  name: string;
  /** IWorkerSpecifier contract on mainnet (anon-rpc SPEC §4). */
  specifier: `0x${string}`;
  /** keccak256 of the worker bundle; also the ABI return data of `workerHash()`. */
  workerHash: `0x${string}`;
  /** Decoded `workerResolvers()` (informational; the raw value below is what the harness reads). */
  resolvers: readonly string[];
  /** Raw ABI return data of `workerResolvers()` as read from the contract. */
  resolversRaw: `0x${string}`;
  /** Worker config delivered as `anonRpcWorker.config` (worker-defined schema). */
  config: Record<string, unknown>;
}

/** tor-js demo gateway. tor-js calls it "demonstration only… may disappear"; run our own if needed. */
export const TOR_JS_DEMO_GATEWAY = "152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ";

export const TOR_JS_PIN: WorkerPin = {
  name: "tor-js 0.4.4",
  specifier: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e",
  workerHash: "0x5b62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b",
  resolvers: [
    "https://cdn.jsdelivr.net/npm/tor-js@0.4.4/dist/anon-rpc-worker.js",
    "https://unpkg.com/tor-js@0.4.4/dist/anon-rpc-worker.js",
    "https://raw.githubusercontent.com/ethereum/tor-js/keccak/5b/62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b",
    "kps:152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ/keccak/5b/62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b",
  ],
  resolversRaw:
    "0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000004168747470733a2f2f63646e2e6a7364656c6976722e6e65742f6e706d2f746f722d6a7340302e342e342f646973742f616e6f6e2d7270632d776f726b65722e6a7300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003668747470733a2f2f756e706b672e636f6d2f746f722d6a7340302e342e342f646973742f616e6f6e2d7270632d776f726b65722e6a7300000000000000000000000000000000000000000000000000000000000000000000000000000000007a68747470733a2f2f7261772e67697468756275736572636f6e74656e742e636f6d2f657468657265756d2f746f722d6a732f6b656363616b2f35622f3632663335386365376132623934656539626333613065366130383735376462363866613038666333343832373666333165646137383861656338313862000000000000000000000000000000000000000000000000000000000000000000000000008f6b70733a3135322e3233362e332e32323a31323239383a7545694348305664626872797a4a634d7443664230764c4134734f76486451346871357737436f70637755353962512f6b656363616b2f35622f36326633353863653761326239346565396263336130653661303837353764623638666130386663333438323736663331656461373838616563383138620000000000000000000000000000000000",
  config: { gateways: [TOR_JS_DEMO_GATEWAY] },
};

/**
 * Use different tor-js gateways (e.g. our own) without touching the pinned bundle.
 * The gateway only relays encrypted Tor traffic; it is a transport choice, not a trust anchor.
 */
export function withGateways(pin: WorkerPin, gateways: readonly string[]): WorkerPin {
  if (gateways.length === 0) return pin;
  return { ...pin, config: { ...pin.config, gateways: [...gateways] } };
}

/** Backup worker. Not wired into the P1 page yet. */
export const NYM_PIN: WorkerPin = {
  name: "Nym anon-rpc-worker 0.1.0",
  specifier: "0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0",
  workerHash: "0xf13a448a8721b9d0b20da3d5b80ffe00bf4c5bb3aae812a38d3d1e3bc81fceb8",
  resolvers: [
    "https://cdn.jsdelivr.net/npm/@nymproject/anon-rpc-worker@0.1.0/dist/nym-anon-rpc-worker.js",
    "https://unpkg.com/@nymproject/anon-rpc-worker@0.1.0/dist/nym-anon-rpc-worker.js",
    "https://raw.githubusercontent.com/nymtech/anon-rpc-worker/keccak/f1/3a448a8721b9d0b20da3d5b80ffe00bf4c5bb3aae812a38d3d1e3bc81fceb8",
  ],
  resolversRaw:
    "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000005a68747470733a2f2f63646e2e6a7364656c6976722e6e65742f6e706d2f406e796d70726f6a6563742f616e6f6e2d7270632d776f726b657240302e312e302f646973742f6e796d2d616e6f6e2d7270632d776f726b65722e6a73000000000000000000000000000000000000000000000000000000000000000000000000004f68747470733a2f2f756e706b672e636f6d2f406e796d70726f6a6563742f616e6f6e2d7270632d776f726b657240302e312e302f646973742f6e796d2d616e6f6e2d7270632d776f726b65722e6a730000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008268747470733a2f2f7261772e67697468756275736572636f6e74656e742e636f6d2f6e796d746563682f616e6f6e2d7270632d776f726b65722f6b656363616b2f66312f3361343438613837323162396430623230646133643562383066666530306266346335626233616165383132613338643364316533626338316663656238000000000000000000000000000000000000000000000000000000000000",
  config: {},
};

/**
 * Trusted finalized checkpoint for the light client: the root of trust for every verified read.
 * Pinned Nov 5, 2026, when two beacon APIs (publicnode and ChainSafe's Lodestar node) agreed on it.
 * The header source refuses a checkpoint older than 7 days, so this one works until about Nov 12:
 * refresh it before the submission build (and in any later release).
 */
export const MAINNET_CHECKPOINT = {
  epoch: 487173,
  root: "0x35bd26d77ecef24031f37b86d4be488fd66c472eb68c11595ca1f327a9a54f24",
} as const satisfies { epoch: number; root: `0x${string}` };

/**
 * Candidate public, keyless endpoints. P1 (Nov 5, through tor-js): eth_getProof at the finalized
 * block worked on the first four. publicnode answered "distance to target block exceeds maximum
 * proof window" through Tor (it worked directly), so it is last and should not count toward the pool.
 */
export const MAINNET_EXECUTION_ENDPOINTS = [
  "https://eth.drpc.org",
  "https://rpc.mevblocker.io",
  "https://eth.blockrazor.xyz",
  "https://eth-mainnet.public.blastapi.io",
  "https://ethereum-rpc.publicnode.com",
] as const;

export const MAINNET_BEACON_ENDPOINTS = [
  "https://ethereum-beacon-api.publicnode.com",
  "https://lodestar-mainnet.chainsafe.io",
] as const;
