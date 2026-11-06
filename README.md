# DeRPC

**A decentralized RPC pool for private, verified Ethereum reads.**

DeRPC runs in the browser. It sends requests through [Anon-RPC](https://github.com/ethereum/anon-rpc), checks responses against a light client, and retries failed reads within the user's manual selection or explicit automatic policy. Selection and verification happen on the user's device, with no central DeRPC proxy and no direct RPC fallback.

The first version is a read provider for apps and wallet integrations, with an EIP-1193 interface and a viem transport. **Ethereum mainnet reads only; experimental and not ready for production.** Built at ETHGlobal Mumbai, November 5–7, 2026.

[ENS/IPFS deployment](web/README.md#ensipfs-deployment) · [Run it](#run-it) · [Integrate](#use-it-in-a-browser-app) · [Supported reads](#supported-reads) · [Status](#status-and-next-steps) · [Validation](#validation) · [Privacy](#privacy-and-trust)

## What's implemented

The current release target is the **free pool**. Reading needs no wallet connection or deposit; payment controls remain off by default.

| Component | Available now |
|---|---|
| Verified browser provider | Anonymous execution and beacon requests, finalized headers, account/storage proofs, code-hash checks and an on-chain worker-pin check. EIP-1193 and viem interfaces. |
| Operator selection | Manual selection or explicit Balanced, Fastest and Reliable modes; operator-first grouping, exact allowlists, account affinity, bounded sibling failover and local proof-failure exclusion. |
| Dashboard and directory | Grouped operator choices and node observations, verified reads, simulated corruption, lifecycle evidence tracking and unsigned onboarding fragments. Export does not register a node. |
| Local EVM | Explicitly enabled, bounded calls against authenticated mainnet state, including general fully on-chain ENS resolution. Raw remote call results are not trusted. |
| ENS discovery and tooling | Curated registrar, proven membership/records, scoped resolver permissions, unsigned deployment plans and receipt verification. Real independent operator registrations remain pending. |
| Operator wrapper | Filtered execution/beacon proxy, Tor onion service, reciprocal identity checks, a separately authenticated personal service, Docker packaging and restoration checks. |
| Test payments and sponsorship | Prepaid escrow, vouchers signed after verification, durable settlement, delegated spending limits and a coordinator that independently verifies completion. Public paid-session rollout remains pending. |

The query escrow is deployed on **Hoodi (chain 560048)** at `0x9053513aCA73bAc0aF6a9942fd93832fd313B0bb`, with a [checked deployment manifest](contracts/deployments/payment-hoodi-deployment-2026-11-06.json) and [second-source verification](contracts/deployments/payment-hoodi-crosscheck-2026-11-06.json). This is separate from Ethereum mainnet read verification; it does not establish a completed public paid-read/settlement cycle.

The free runtime groups **up to eight endpoints under one ENS operator identity**, with operator-first selection and node-local health/failover. The versioned record, wrapper identity and local integration work are documented in [M1](specs/ENS_TOR_MILESTONE.md). Public multi-endpoint enrollment, a reliable hosted demo, operator/node staking, traffic-based stake requirements and slashing remain [release gates or later work](#status-and-next-steps).

## Run it

Use Node 24 and pnpm 11.22.0, the version pinned in `package.json`. The free verified-read demo needs no wallet, API key or funds. Optional payment demonstrations require a wallet and test funds.

The public deployment target is `derpc.eth.limo`, with the directory and dashboard on IPFS. The [release package is prepared](web/deployment-ens-ipfs-2026-11-06.json); persistent public pinning, the owner-signed ENS contenthash update and a working public Tor gateway remain pending. The temporary Vercel deployments were removed at the team's request. Follow the [ENS/IPFS instructions](web/README.md#ensipfs-deployment) for publication and the [release gates](#status-and-next-steps) before relying on public reads.

```sh
pnpm install
pnpm dev
```

Open [localhost:5173](http://localhost:5173). The workspace contains three pages:

| Page | What it shows |
|---|---|
| [`/`](http://localhost:5173/) | The operator dashboard: choose routing and operators, inspect local observations, read verified ETH/WETH balances and code, reject a simulated bad response, and close the worker. |
| [`/example.html`](http://localhost:5173/example.html) | A small integration using only the public provider API and viem, including an unsupported-method error. |
| [`/network-check.html`](http://localhost:5173/network-check.html) | Transport diagnostics: Tor exit checks, candidate RPC/beacon probes and worker logs. Uses public test addresses; probes are not verified application reads. |

In the main demo, select operators manually or apply Balanced, Fastest or Reliable routing over all eligible free entries or a restricted list. An empty restriction stops reads. A fresh browser profile starts with none selected; later visits restore authorized bootstrap preferences, while saved ENS preferences wait for proven discovery. Wait for the worker, light client and worker-pin check, then run the reads. In Manual mode the corruption control alters a response locally to demonstrate rejection and failover; it is not evidence that a real operator lied. Closing the worker demonstrates failure without direct fallback; reload to start again.

Optional ENS discovery takes the deployed ENSv2 registry and registrar pin, with separate list/record verification labels. Test payments start off: select a real paid operator from that directory, load the receipt-verified escrow manifest produced by [the deployment commands](contracts/README.md#test-payment-deployment), then connect a wallet funded on the matching test chain. The UI checks the network and escrow runtime before requesting a deposit. The wrapper must also be configured for that escrow and funded for settlement. A verified deployment file alone does not demonstrate a successful paid read or payout; those receipts remain release gates. Personal onion addresses, tokens and session signing keys stay in memory.

### Gateway and checkpoint

The default configuration uses the tor-js demonstration gateway; its availability is not guaranteed, and the public-gateway QA check remains unresolved. To use your own [tor-js gateway](https://github.com/ethereum/tor-js), copy [`frontend/.env.example`](frontend/.env.example) to `frontend/.env.local` and set `VITE_TOR_GATEWAYS` to comma-separated KPS addresses (`ip:port:certhash`, without a `kps:` prefix). Integrators can pass the same list as `createDeRPC({ gateways })`. The [operations guide](specs/OPERATIONS.md) covers gateway and release checks.

The light client starts from a trusted checkpoint in [`provider/src/config/mainnet.ts`](provider/src/config/mainnet.ts). The shipped checkpoint is dated **November 5, 2026**; startup rejects checkpoints older than seven days and cross-checks the configured epoch against the verified bootstrap. Refresh the root and epoch together from a trusted, recent finalized checkpoint before running an older checkout. A `checkpoint` option can override the shipped pair.

Run `pnpm dev:site` to serve the directory and the demo from one port instead: the directory at [localhost:5174](http://localhost:5174) and the demo pages under [`/demo/`](http://localhost:5174/demo/), the same layout as the static site. The operator onboarding page exports a local configuration draft; it does not deploy contracts, register ENS names or start services. Other networks are listed for reference; verified reads remain Ethereum mainnet only.

To build and preview the directory and demo as one static site, supply a public gateway in the shell:

```sh
VITE_TOR_GATEWAYS='PUBLIC_IP:PORT:CERTHASH' pnpm build:site
VITE_TOR_GATEWAYS='PUBLIC_IP:PORT:CERTHASH' node scripts/check-release.mjs
pnpm --filter web preview
```

Replace the gateway placeholder before building. Deploy **`web/dist/`**: the directory lives at `/`, and the demo, integrator example and diagnostics live under `/demo/`. Both builds use relative assets for IPFS gateway paths. `pnpm build:web` builds only the directory; `pnpm build` builds only the demo in `frontend/dist/`.

Use the same gateway setting for the build and release check. The offline checker validates checkpoint freshness and build markers, public gateway inputs, assembled pages/assets, initial payment controls and known local-file/address patterns. It returns a nonzero exit status on errors; `--json` emits a report. Public gateway reachability, fresh-browser behavior and the committee-transition test remain separate live gates.

Release demo builds ignore `.env` files, require an explicit public gateway, append the demo gateway as a fallback, and scan emitted assets for non-public addresses. For a LAN gateway, use `pnpm --filter frontend build:local`; it reads `frontend/.env.local` and writes `frontend/dist-local/`, which is not for deployment.

## Use it in a browser app

`@derpc/provider` is currently a **private workspace package**, not a published npm release. The runnable example is [`frontend/src/example.ts`](frontend/src/example.ts). Browser bundlers also need the BLS WASM alias in [`frontend/vite.config.ts`](frontend/vite.config.ts): `@chainsafe/bls` → `@chainsafe/bls/herumi`.

```ts
import { createDeRPC, MAINNET_OPERATORS } from "@derpc/provider";
import { derpcTransport } from "@derpc/provider/viem";
import { createPublicClient } from "viem";
import { mainnet } from "viem/chains";

// Example values: in an app, take these from the user's selection.
const userChoice = ["mevblocker.derpc.eth", "blockrazor.derpc.eth"];
const derpc = createDeRPC({
  operators: MAINNET_OPERATORS.filter((op) => userChoice.includes(op.ens)),
});
const client = createPublicClient({
  chain: mainnet,
  transport: derpcTransport(derpc),
});

try {
  await derpc.ready;
  const balance = await client.getBalance({
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    blockTag: "finalized",
  });
  console.log(balance); // ETH held by the WETH contract, in wei
} finally {
  derpc.close(); // In an app, close when the provider is no longer needed.
}
```

**Pass `blockTag: "finalized"`.** viem defaults to `"latest"`, which DeRPC refuses. The built-in `.derpc.eth` names are mock identifiers in a curated bootstrap list, not registered operator identities. Automatic adoption from ENS requires both proven registrar membership and proven records. See the [ENS and payment release gates](specs/OPERATIONS.md).

To opt into automatic routing instead of supplying a manual selection:

```ts
const derpc = createDeRPC({
  operators: [...MAINNET_OPERATORS],
  selection: "balanced", // also "fastest" or "reliable"
  allowedOperators: ["mevblocker.derpc.eth", "blockrazor.derpc.eth"],
});
```

Omitting `allowedOperators` permits all eligible free candidates in the supplied source; `[]` permits none. Automatic modes use recent local verified outcomes and retain an account's operator while it remains eligible. They do not certify honesty or global uptime, and they do not select personal credentials, paid sessions or simulated corrupt operators. See [routing policy details](provider/README.md#automatic-selection).

`createDeRPC()` starts the worker and light client immediately. Execution reads require an explicit operator selection, while beacon sync can begin before that selection.

| API | Behavior |
|---|---|
| `derpc.provider` | EIP-1193 `request`, `on` and `removeListener`; usable without viem. |
| `derpc.ready` | Waits for the worker and a fresh verified header. State reads separately wait for the on-chain worker-pin check. |
| `derpc.reader` | Returns `{ value, block }` so callers can show the verified block. Includes token balances for a supplied storage layout. |
| `derpc.setOperators(operators)` | Changes the selected pool, cancels work using the previous selection and carries existing session exclusions forward. |
| `derpc.setRouting(policy, operators?)` | Atomically changes Manual/Balanced/Fastest/Reliable selection and an optional exact allowlist; automatic modes remain free-only. |
| `derpc.refreshDirectory(options)` | Manual mode retains valid chosen names; automatic mode requires proven membership and records before adopting eligible entries. Proven snapshots expire and require a newer verified refresh. |
| `derpc.verifiedCall(input)` | Opt-in host execution against proven state; disabled by default. See the [provider guide](provider/README.md#verified-local-execution). |
| `derpc.status()` | Reports transport, light-client, checkpoint, pin and operator state. `onStatus` and `onPoolEvent` provide updates. |
| `derpc.close()` | Aborts pending work and closes the worker and header source. Paid sessions must flush their final voucher before closing transport. |

The viem transport disables viem's own retries so the pool controls which operators see each request.

## Supported reads

All state reads target the light client's **verified finalized block**, which can lag the chain head. This is a limited read provider, with no signing or transaction submission.

| Method | Result and verification |
|---|---|
| `eth_getBalance` | Balance from a verified account proof. |
| `eth_getTransactionCount` | Nonce from a verified account proof. |
| `eth_getCode` | Bytecode checked against the proven account's code hash. |
| `eth_getStorageAt` | Storage value checked against the proven storage root. |
| `eth_blockNumber` | The verified finalized block number from the light client. |
| `eth_chainId`, `net_version`, `eth_accounts` | Local metadata: `"0x1"`, `"1"`, and `[]`. |

State methods accept an omitted block selector, `"finalized"`, or a hex block number matching the current verified block. `{ blockNumber }` and `{ blockHash }` selectors must also match that block. Other blocks and tags such as `"latest"`, `"pending"` and `"safe"` are refused. Historical reads are not supported.

By default, other methods are refused rather than forwarded, including `eth_call`, logs, gas estimation and writes. A normal viem `readContract()` therefore fails unless the application explicitly enables the bounded local executor with `verifiedCalls: { eip1193: true }`. `verifiedCalls: true` instead enables only the explicit `derpc.verifiedCall()` API. Both execute in the host against proven state; neither trusts a raw remote call result. The demo's WETH balance uses its known storage mapping at slot 3 through `derpc.reader.getTokenBalance()`; this does not establish generic ERC-20 support. See [the provider guide](provider/README.md) for limits and ENS/payment integration.

Provider errors use `4200` for unsupported methods, `-32602` for invalid inputs/block selectors, `-32002` for unavailable verified reads, `4900` for recognized transport disconnection, and `-32603` for unexpected failures. Mapped errors include the underlying name in `data.reason`. Inspect that reason and provider status when reporting failures; neither an error nor a timeout enables direct fallback.

## How it works

1. **Bootstrap without a direct RPC call.** The harness receives the worker hash and resolver list from local pinned configuration, downloads the bundle and checks its hash before running it.
2. **Authenticate the state root.** A host-side Lodestar light client verifies sync-committee updates from a trusted checkpoint. Beacon requests go through the worker, including polling for updates; no direct event stream is opened.
3. **Verify the worker pin.** Through the selected operators, DeRPC proves the specifier contract's `workerHash` storage and compares it with the local pin before serving account, code or storage reads.
4. **Verify each answer.** The host checks EIP-1186 account/storage proofs against the authenticated state root and checks bytecode against its proven hash. Verification stays outside the untrusted worker.
5. **Handle failures locally.** Manual pools use priority tiers; automatic pools use the selected local routing policy. Both exclude endpoints whose proofs fail, give endpoint failures a cooldown and retry sequentially within attempt and time limits. Anonymity-network failures renew the route without penalizing endpoint health. Exclusions last for the running provider instance, not a global ban. Optional paid reads reserve bounded credit before requests and sign vouchers only after verification; a completion/signing failure cannot trigger payment to another operator through a retry.

DeRPC supplies the pool, proof verifier, pin gate, transport adapters, provider API and demo. It reuses the [Anon-RPC browser harness](https://github.com/ethereum/anon-rpc), [tor-js](https://github.com/ethereum/tor-js), [Lodestar](https://github.com/ChainSafe/lodestar) and [viem](https://github.com/wevm/viem). The workspace pins harness 0.4.0, tor-js 0.4.4, Lodestar 1.43.0 and viem 2.57.8.

The [Lodestar patch](patches/@lodestar__light-client@1.43.0.patch) backports finality-validation fixes, disables unsafe forced committee updates, and stops abandoned startup/synchronization loops. Its regression tests are part of the normal suite. Keep the dependency pins, overrides and patch in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) when reproducing the build; fork compatibility must be checked before upgrading or adding networks.

## Status and next steps

As of **November 6, 2026**, the core provider, dashboard, wrapper, contracts and payment modules are implemented. The free browser flow has recorded local-gateway and onion evidence; public release is not yet cleared. The [roadmap](specs/ROADMAP.md) and [operations guide](specs/OPERATIONS.md) distinguish implementation from deployment and verification gates.

| Area | Remaining work |
|---|---|
| Free public release | Reliable public gateway and all-onion path, fresh-browser hosted checks, a recent trusted checkpoint. The local period-1904 cold start [passed November 6](provider/test/light-client/period-1904-evidence-2026-11-06.json). |
| ENS lifecycle: M1-A | Two independent operators with real registrations, proven discovery, restricted rotation and delisting observed after finalized refresh. Bounded snapshot validity and unsigned lifecycle tooling are current integration work; they do not establish a live deployment. |
| Multiple endpoints: M1-B | Separate operator and endpoint identities, endpoint-level failover and several endpoints under one ENS name without increasing that operator's selection weight. Both M1-A and M1-B are required for [M1 completion](specs/ENS_TOR_MILESTONE.md). |
| Payments, after the free release | Public funding/read/settlement/refund demonstration, deployment of a configured app coordinator and external readiness reviews. The Hoodi escrow deployment alone does not satisfy these gates. |
| Later economics | Specify and implement operator/node staking, traffic measurement, stake adjustment and accountability. Query escrow is not a staking contract. |

The reviewed branch fixes for startup recovery (#34), outage attribution (#35), cache isolation (#38) and block selectors (#39) are integrated with the newer ENS and payment code. [QA evidence](specs/QA_REPORT.md) distinguishes offline tests, Firefox diagnostics and live committee verification; these checks do not publish a new release.

For operating a service, start with the [wrapper runbook](wrapper/README.md). Use the [contract guide](contracts/README.md) for ENS and escrow administration, and the [sponsored-read guide](payments/examples/README.md) for app-funded requests. The latter requires an application-supplied authenticated header/funding source and protected coordinator; it does not establish a conforming anonymous Node runtime.

Additional EVM chains need their own authenticated headers, proof/finality rules and tested endpoints; JSON-RPC compatibility alone is insufficient. Nym has a pin in the configuration but has not been validated as a runtime here.

## Privacy and trust

The standalone [threat model](THREAT_MODEL.md) describes the browser, ENS, wrapper and payment trust boundaries, implemented controls and remaining evidence gates.

RPC and beacon endpoints still see query content and timing; Tor changes the route they observe. Account isolation depends on worker behavior and remains unproven. A curated endpoint list, several URLs or mock ENS names do not establish independent operators or decentralized discovery. An ENS list stays curated while the parent owner can repoint its registry and a curator controls admission.

**Paid queries are linkable to the paying account.** A funded session and its signed cumulative vouchers intentionally link reads to that payer. Test payments demonstrate a mechanism, not operator income. The host holds a disposable session key when payments are enabled; signing capability and private session keys never enter the untrusted worker. SDK limits constrain normal use; the deposit is the hard on-chain limit if that key is compromised. Personal-node tokens are kept in memory and sent through the worker to the selected service in request headers; they must not be published in ENS or persisted in browser storage.

| Traffic | Route and exposure |
|---|---|
| Execution reads, including proofs and code | Through the worker and Tor, using an exit or an onion connection. Operators see query content. |
| Beacon bootstrap and updates | Through the worker and Tor. The beacon endpoint sees those requests. |
| ENS discovery and endpoint identity checks | Through the worker. Discovery probes all candidates with identity requests and the same public worker-pin proof, without user-account queries. Anonymity does not make an unverified directory result proven. |
| Payment vouchers and paid read credentials | Through the worker to the chosen operator. They link requests to its funded payment session. |
| Wallet deposit, top-up and refund transactions | Through the user's wallet and its configured payment-chain RPC, outside the worker. The payer and transactions are public on-chain; that RPC may also observe the wallet's IP. |
| Operator settlement and deployment administration | Through the operator/admin payment or ENS RPC, outside the browser read worker. These connections never serve as a direct fallback for client reads. |
| Harness bootstrap calls | Answered locally from the pin; no RPC request. The on-chain hash is then proven through the worker. |
| Worker bundle download | Before the worker exists, tries the selected gateway's hash-addressed KPS mirror first, then the declared bundle resolvers, including HTTPS CDNs. Bytes remain hash-checked. The serving gateway/CDN sees the downloader's connection; successful gateway delivery avoids an additional CDN request. |
| Tor gateway connection | Direct over WebRTC. The gateway sees the client's IP and relays encrypted Tor traffic. |
| Page assets | Direct from the page host, which sees visitors' IPs. |

The demo's direct-connections table is a resource-timing aid, not a complete traffic audit: it does not capture the WebRTC gateway link and may omit other requests. There are no third-party analytics in the app.

The wrapper contains no Tor gateway, and the client refuses declared or independently known same-operator gateway/RPC pairings. Undisclosed common ownership remains unknown. Local wrapper demonstrations run by this team may use both its gateway and its public-node proxy; that arrangement is a disclosed test configuration, not evidence of operator independence or resistance to timing correlation.

Correctness relies on the trusted checkpoint, light-client consensus assumptions, host verifier and shipped application code. A bundle hash identifies worker code; it does not prove the worker provides anonymity. Freshness checks reject headers older than 30 minutes both when accessed and before pending verified reads return. This prototype has not had an independent security audit.

### CROPS

- **C — Censorship resistance:** A static app with local selection and verification; no required DeRPC RPC proxy. Operators and gateways are replaceable, but unavailable routes still cause reads to fail.
- **O — Open source:** MIT, buildable from this repo with public dependencies. Free reads need network access and a recent checkpoint, with no account or API key; optional paid tests need a wallet and test funds.
- **P — Privacy:** RPC and beacon traffic uses Tor by default. Queries remain visible to endpoints; the gateway, bundle resolver and page host see the connections described above. No analytics; no account-unlinkability claim.
- **S — Security:** The read provider does not expose wallet signing or transaction submission. Optional payments keep a limited session signer in the host; the untrusted worker gets no private key. Host-side verification checks supported answers against authenticated state. The experimental contracts and unresolved release gates limit production use.

## Development

The durable payment-store tests require Linux and util-linux `flock`, in addition to Node 24 and pnpm. Default contract tests use local chains; live browser, Docker and ENS fork checks have separate setup in their package guides.

```sh
pnpm -r test
pnpm typecheck
pnpm --filter @derpc/contracts compile
pnpm --filter frontend build:local
```

The automated tests use recorded fixtures, generated cryptographic proofs, test doubles and local-chain integration. They do not validate current live-network reachability. The production build still reports externalized Node modules and a large bundle. Live browser tests remain necessary for transport failures, privacy checks and browser compatibility.

### Validation

The November 6 final default workspace run passed **1,004 tests** in the working tree: 65 contracts, 68 payments, 576 provider, 58 wrapper and 237 frontend. Five opt-in ENS fork tests were skipped by that command; affected contract/provider suites also passed in focused follow-up checks. Workspace type checking, the combined static-site build and the offline 46-file release check passed. The [QA report](specs/QA_REPORT.md#local-release-completion--november-6-1612-utc) records scope, live checks and remaining gates. These checks extend the earlier 656-test committed snapshot at `96439b4`; the follow-up implementation is now recorded in local commits.

| Evidence | What was observed |
|---|---|
| [Five-endpoint roster check](provider/test/fixtures/automatic-roster-live-2026-11-06.json) | All five configured public endpoints returned verified reads through Tor in Firefox at block 26356307. Mock ENS names remained explicitly labeled. |
| [Automatic-routing check](provider/test/fixtures/automatic-routing-live-2026-11-06.json) | Balanced/Fastest/Reliable behavior, retained account affinity, empty-list refusal and one exact allowed operator at block 26356339; worker pin verified, no direct RPC/beacon requests observed, and shutdown refused further reads. |
| [Onion and local-execution check](wrapper/test/live-evidence-2026-11-06.json) | Real pinned-worker onion reads, host verification of an ENSv2 resolver call, personal authentication, identity rejection and failover. The gateway and proxy were run by the same tester. |
| [General ENS execution](provider/test/fixtures/ens-mainnet-execution-evidence-2026-11-06.json) | Nine offline checks using actual mainnet ENS bytecode and account/storage proofs, including forged-state rejection. Administrative capture and an injected root are distinct from light-client or Tor evidence. |
| [Multi-endpoint wrapper packaging](wrapper/test/multiendpoint-packaging-evidence-2026-11-06.json) | Built-image node identities, invalid configuration refusal and 58 wrapper tests. This isolated packaging check sent no public transactions. |
| [Sibling onion failover and general ENS](wrapper/test/multiendpoint-evidence-2026-11-06.json) | Two warmed test onions, controlled failure, sibling affinity, explicitly selected fallback, general ENS resolution and shutdown at verified mainnet block 26356914. Same-party proxies and mock operator identity; no public ENS enrollment. |
| [ENS fork checks](contracts/deployments/ens-fork-evidence.json) and [discovery integration](contracts/deployments/ens-fork-discovery-evidence.json) | Actual ENS contract bytecode, permissions and deployment verification, plus a separate locally constructed proof-root integration. These are not public operator registrations. |
| [Payment container lifecycle](wrapper/test/payment-container-evidence-2026-11-06.json) | Local-chain paid reads, restart recovery, settlement and unused-deposit refunds; distinct from the public Hoodi deployment. |
| [Gateway bundle delivery](provider/test/transport/kps-bootstrap-live-2026-11-06.json) | Fresh Firefox loaded the hash-checked worker through the local gateway with no CDN request, then refused a fetch after close. Bundle delivery only; no execution/consensus proof was requested in this check. |
| [Browser timing diagnostics](frontend/test/direct-connections-browser-evidence-2026-11-06.json) | Normal/private Chromium cache and missing-API cases on both pages. Transport was stubbed for these UI checks; this is not a live anonymity observation. |
| [QA report](specs/QA_REPORT.md) | Earlier full-project review, reproduced defects and their corrections, with the public-gateway and release limitations preserved. |

These are dated functional observations, not uptime guarantees, general latency benchmarks or an independent security audit. The browser checks used the local development gateway; they do not clear the hosted public-gateway release gate.

### Repository guide

| Location | Contents |
|---|---|
| [`provider/src/api/`](provider/src/api/) | Public provider, lifecycle and viem transport. |
| [`provider/src/transport/`](provider/src/transport/) | Anon-RPC startup, local bootstrap and fetch/JSON-RPC adapters. |
| [`provider/src/light-client/`](provider/src/light-client/) | Verified headers and anonymous beacon polling. |
| [`provider/src/verify/`](provider/src/verify/) | Proof verification, verified reads and worker-pin checks. |
| [`provider/src/pool/`](provider/src/pool/) | Operator selection, retries, exclusions and caching. |
| [`provider/src/discovery/`](provider/src/discovery/) · [`provider/src/operators/`](provider/src/operators/) | ENS membership/record discovery, endpoint validation and identity checks. |
| [`provider/src/execution/`](provider/src/execution/) | Bounded local EVM execution against authenticated state. |
| [`provider/src/config/mainnet.ts`](provider/src/config/mainnet.ts) | Checkpoint, worker pins, curated operators and known token layouts. |
| [`frontend/`](frontend/) | Operator dashboard, routing and payment controls, minimal integration and diagnostics. |
| [`web/`](web/) · [`brand/`](brand/) | Directory, product pages, onboarding drafts and brand assets. |
| [`wrapper/`](wrapper/) | Operator/personal onion services, filtered proxy and durable settlement. |
| [`payments/`](payments/) | Client sessions, delegated budgets, durable coordinator and sponsored-read examples. |
| [`contracts/`](contracts/) | Escrow and ENS registrar contracts, deployment/lifecycle tools and public/local evidence. |
| [`specs/`](specs/) · [`THREAT_MODEL.md`](THREAT_MODEL.md) | Decisions, milestone gates, operations, QA and security boundaries. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Request flow, verification boundaries and trust assumptions. |
| [`FEEDBACK.md`](FEEDBACK.md) · [Submission packet](specs/SUBMISSION_DRAFT.md) | Partner observations, prepared form text and a timed human-narrated demo runbook. |

Each package keeps its tests alongside its implementation. [REPO_LAYOUT.md](REPO_LAYOUT.md) maps the full repository; [AI_USAGE.md](AI_USAGE.md) records assisted work and attribution still awaiting team completion.

## License

[MIT](LICENSE)
