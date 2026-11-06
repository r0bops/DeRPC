# DeRPC: a decentralized RPC pool

ETHGlobal Mumbai, Nov 5–7, 2026. Submission due **Sat Nov 7, 09:00 IST**.
Target: Ethereum Foundation, Anon-RPC track ($2,500 / $1,500 / $1,000). The EF prize page lists "combine anon-rpc with a light client or proof verification" among its ideas. Also entering EF Best CROPS App. The EF places a project in at most one EF prize. Full prize details and fit analysis are in [TRACKS.md](TRACKS.md).
Mentor feedback (EF): narrow the scope and make it more secure.

## 1. One-liner

DeRPC is a decentralized RPC pool for apps, wallets and agents, starting with Ethereum. Its client-side provider selects independent endpoints, routes supported reads through Anon-RPC, verifies answers with a light client and `eth_getProof`, and fails over anonymously. It rejects anything it can't prove and never falls back to direct RPC.

Wallet integrators are the first target, demonstrated through a browser app. The pool is the product; an explorer-style status screen makes it visible. Discovery starts curated, while selection and verification run on the user's device. Server-side agents and additional EVM chains require their own tested runtime and verification paths. The prioritized implementation plan and completion gates are in [ROADMAP.md](ROADMAP.md).

## 2. Problem

- A few big RPC providers see who is asking (their IP) and what they ask.
- Wallets trust whatever the RPC returns, so a lying node goes unnoticed.
- Anon-RPC fixes the first point (who is asking) but not the second (whether the answer is true).

## 3. Background: what Anon-RPC is

Source: github.com/ethereum/anon-rpc, spec v0.4.0, Oct 23 2026.

- A standard, not a network. The wallet (**host**) loads an anonymizing client (**worker**) pinned on-chain by its keccak hash through a **specifier contract**, and runs it in a sandbox (**harness**).
- The worker gets only fetch-style calls, KPS streams, storage and logs. No DOM, cookies or keys.
- Harnesses: browser (`@anon-rpc/browser-harness`), browser extension, and Node (QuickJS, not yet conforming).
- Workers: passthrough (a reference, with no anonymity), tor-js, Nym and Nox. Adopters: Privacy Pools and Kiwi News.
- It hides who is asking. It does not hide what is asked, and it does not verify answers.

## 4. Decisions so far

| Decision | Choice | Why |
|---|---|---|
| Name | DeRPC | Short, reads as "decentralized RPC," fits with DeFi and DePIN |
| Product and audience | Client-side RPC pool for apps, wallets and agents; wallet integrators first | One read provider, demonstrated in a browser app; no required central DeRPC proxy |
| Track | EF Anon-RPC (primary), also tag EF CROPS. Add ENS Best Use of ENSv2 only if the day-2 stretch ships. | Narrow scope, per the mentor. CROPS needs no extra build, only a README section and a short video. ENS is gated (see §5). |
| Architecture | Host-side verifying wrapper around any worker, not a new worker | The spec treats worker code as untrusted, so verification must live in the host. Works with tor-js, Nym or Nox. |
| Verification | Sync-committee light client from a pinned checkpoint, plus `eth_getProof` (EIP-1186) | Establishes supported-read correctness without trusting RPC responses; checkpoint and verifier assumptions remain |
| Bootstrap plan | Pin worker hash and resolver list locally, then verify the hash on-chain through the worker. **Built (#6, Nov 5):** slot 1 of the specifier is proven against the light client's verified state, and reads are gated on it. | Answers both bootstrap calls without direct RPC; user reads wait for verification. Tested live in Firefox: the normal pin verifies; a wrong pin blocks every read; a bad bundle hash stops the worker before anything is sent. Update procedure in ANON_RPC.md. |
| Library | **Lodestar light client 1.43.0**, only for verified headers and state roots. DeRPC's own pool fetches `eth_getProof`, and DeRPC's own verifier checks it. The light client sits behind a small swappable interface. (Decided Nov 5, after testing.) | The only candidate that passed all checks: every request went through the injected `fetch`, it started from a pinned checkpoint with no hosted prover or checkpoint server, and its state root matched the chain. Colibri's local mode failed; Helios has no `fetch` option. Conditions: backport Lodestar's fix #9419 with a regression test; pin `@chainsafe/ssz` ≤ 1.7.0; stub `@lodestar/spec-test-util`. The package is unmaintained and has no Gloas support (§9). |
| Anonymity worker | **tor-js** (mainnet specifier `0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e`); Nym as backup (`0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0`) | tor-js 0.4.4 is the version the contract pins. It adds per-key circuit isolation, documented but not yet observed. Worker config: `{ gateways: [kpsAddr], logLevel?, bootstrap? }`. |
| Worker pin (read Nov 5 at block 26349613; two RPCs agreed) | **tor-js** `workerHash` `0x5b62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b`. Resolvers: jsDelivr and unpkg `tor-js@0.4.4/dist/anon-rpc-worker.js`, `raw.githubusercontent.com/ethereum/tor-js/keccak/5b/…`, and a `kps:` entry on the demo gateway. **Nym** `workerHash` `0xf13a448a8721b9d0b20da3d5b80ffe00bf4c5bb3aae812a38d3d1e3bc81fceb8`; resolvers: jsDelivr and unpkg `@nymproject/anon-rpc-worker@0.1.0`, and raw.githubusercontent. | Shipped as local config. The raw ABI return data is kept in the provider config. These values were read without proof; verifying slot 1 through the worker (P2) is what makes them trusted. |
| Read chain | **Ethereum mainnet**, read-only | The worker contracts are on mainnet. Lodestar 1.43.0 can't follow Sepolia (Gloas). Reads cost nothing and need no keys. Hoodi works as a free testnet for development. |
| Checkpoint policy | Pin a finalized checkpoint root in the build and refresh it before submission. Initial limit: refuse to start from a checkpoint older than 7 days. | Conservative, and well inside the weak-subjectivity window. The head-freshness limit gets set in P2. |
| Tor gateway | **Run our own `tor-js-gateway`**, built from tor-js v0.4.4 (gateway 0.3.0, source in `reference/tor-js/`): locally for development and the laptop demo, and on a public server for `derpc.eth.limo` visitors. The demo gateway `152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ` stays as the default and backup. The frontend reads `VITE_TOR_GATEWAYS`. | The demo gateway warns it's "demonstration only… may disappear", and its fast bootstrap timed out in the team's run (49 s boot). A gateway only relays encrypted bytes to consensus-listed Tor relays. It sees the client's IP, but not destinations or content. |
| Demo app (updated Nov 6) | Operator dashboard with local health/proof evidence, user selection, verified reads, rejection/failover, and operator onboarding drafts | One operator identity can authorize several distributed endpoints in the implemented M1-B model. Local drafts and test fixtures must not claim public enrollment or deployment. See [DEMO_WORKFLOW.md](DEMO_WORKFLOW.md). A full RPC explorer stays out of scope. |
| Site packaging (Nov 6 integration) | `web/` holds the directory and product pages; `frontend/` remains the live demo. `pnpm build:site` produces `web/dist/`, with the demo under `/demo/`. Release demo builds require public gateways from the shell; LAN builds stay separate. | One static deployment can expose the directory and the verified-read demonstration; gateway checks prevent shipping a local address. Only mainnet reads are verified, regardless of networks listed in the directory. |
| Public iteration environment (team correction, Nov 6) | Publish the free mainnet alpha through **`derpc.eth.limo`**, with static files on IPFS and `derpc.eth`'s contenthash pointing to them. Do not use Vercel; both temporary deployments were removed. The team will supply an existing VPS for persistent IPFS pinning and the separate Tor gateway. | An IPFS release package is prepared; durable public pinning and the owner-signed website contenthash update remain pending. Direct CID changes require a new ENS update. Operator-directory enrollment is a separate deferred task. Wrapper/provider software remains rebuildable; immutable registrar logic changes require a new deployment. Payments/staking remain deferred. |
| Chain scope | One verified execution chain first (now decided: mainnet, see "Chain" above) | EVM transport compatibility does not establish consensus or proof compatibility. Tor/Nym's recorded mainnet specifiers need mainnet verification even for Sepolia queries |
| Stack | TypeScript, Vite and viem (a custom transport built on `worker.fetch`), with pnpm | The least framework overhead for a client-side library plus a demo page |
| RPC operators | A curated list of public, keyless endpoints, at least two working. **Updated team direction, Nov 6:** retain manual selection and add explicit automatic modes: balanced, fastest and reliable. In automatic mode an omitted allowlist permits all eligible candidates; an empty list permits none. The five built-in endpoints retain mock `<operator>.derpc.eth` names until actually registered. | Automatic routing requires user opt-in. ENS expansion requires both proven membership and proven records; a bootstrap roster is not a verified ENS directory. Several URLs do not prove independent operators. Verification makes a poor choice cost availability, not correctness. |
| Methods | Balance, nonce, code and storage (one known ERC-20 layout), plus block number; explicit opt-in local verified calls | Generic `eth_call` is refused by default. `verifiedCalls` enables bounded local EVM execution against authenticated mainnet state; its EIP-1193 form requires a further opt-in. Unsupported context, history, off-chain lookups, logs and writes stay refused. |
| Integrator API (P4, Nov 5) | `createDeRPC({ operators, gateways })` → an EIP-1193 provider, a reader with proof context, `setOperators`, `status`, `close`; `derpcTransport` for viem (`@derpc/provider/viem`). Only the verified finalized block is accepted; `"latest"` is refused (-32602). | Answering `"latest"` with finalized data would label 13–19-minute-old state as current. viem defaults to `"latest"`, so integrators pass `blockTag: "finalized"`. Whether to offer an explicit opt-in that maps `"latest"` to finalized for wallets is open (§9). |
| Failure mode | Fail closed | No direct fallback, and lying nodes are blocked locally |
| Worker bundle delivery (Nov 6) | Prefer the selected gateway's advertised hash-addressed KPS mirror; retain declared bundle resolvers as fallbacks | A working mirror avoids an extra CDN connection before the worker exists. The harness still hash-checks all bytes; this changes advisory acquisition order, never the worker pin or RPC routing. Gateway availability and upstream bundle-fetch cancellation limits remain separate. |
| Proven ENS snapshot lifetime (Nov 6) | Ten minutes from first acceptance of an authenticated snapshot, capped at 30 minutes after its block timestamp; a newer verified snapshot is needed to renew | Clock rollback, stale cached reads and metadata changes cannot extend authorization. A near-expiry refresh may need an explicit retry using retained, restricted administrative bootstrap. |
| Multiple endpoints per operator (Nov 6 implementation decision) | Version-1 `derpc.endpoints` JSON with 1–8 stable node IDs and canonical RPC/beacon URLs, at most 4096 UTF-8 bytes; operator-first routing and endpoint-local observations | Publishing more URLs must not increase operator selection weight. Invalid plural records fail closed; legacy singular records remain supported only when plural is empty. Plural endpoints are free-only. Exact schema and rotation semantics are in [M1.4](ENS_TOR_MILESTONE.md#m14--bounded-endpoint-model). |
| Privacy | One isolation key per account; verify the deployed worker's behavior | The spec makes isolation worker-dependent. Do not promise account unlinkability merely because a key is passed. |
| Operator wrapper (implemented and tested Nov 6) | An operator-run Tor onion service, bounded proof/code proxy, four beacon routes, reciprocal identity document, setup self-test and separate authenticated personal service. | Real Firefox/tor-js reads through the onion service, identity rejection, personal authentication and anonymous failover passed. The tested service is explicitly a public-node proxy run by the same tester as the gateway; it does not establish independent operators. Setup checks a finalized proof. See OPERATIONS.md and wrapper/test/live-evidence-2026-11-06.json (#49–#55). |
| Payments (implemented; public escrow deployed) | Native-asset prepaid escrow, separate non-spending read/close authorization, cumulative vouchers signed after verification, one session per operator, durable wrapper settlement and optional demo controls. Payments default off and are restricted to test chains. | Local-chain HTTP/provider integration and a paid Docker restart/settlement passed, including rejection without payment and exact unused-deposit refunds. Paid queries are linkable to the paying account. The Hoodi escrow deployment has a checked receipt and matching runtime; a public paid-read/settlement cycle is still pending. See OPERATIONS.md (#56–#62). |
| Payment network | **Hoodi (560048)** hosts the test escrow at `0x9053513aCA73bAc0aF6a9942fd93832fd313B0bb`; Sepolia (11155111) is also supported by escrow tooling. | The payment chain is separate from mainnet read verification and ENS. The user's deployment was checked at 12 confirmations against the reviewed creation bytecode and compiled runtime through two administrative RPC sources; it was not yet finalized at that check. The manifest is in `contracts/deployments/payment-hoodi-deployment-2026-11-06.json`. Sepolia's read-verifier incompatibility does not prevent using it for escrow. |
| Operator economics (updated Nov 6) | Later: stake to mint/register an operator identity, plus stake per node whose required amount changes with network traffic; operator-set price per verified logical read | The team reconfirmed a free demo first. Amounts, traffic measurement/formula, withdrawal and penalties are undecided. No staking contract exists; the payment escrow is separate. Existing paid-session prices remain fixed. |
| Cut from the free release | Active staking/payments, slashing, token incentives, full explorer, global rankings, Arkiv | Display the requested economics as planned. Do not activate money flows or invent global scores to complete the free dashboard. |

### Implementation status, Nov 6

The team explicitly requested completion of ENS #44–49, wrapper #50–55, and payments #56–62, including the previously later verified `eth_call`, app/agent delegation and real-fund readiness. The earlier stretch cuts do not remove those requirements from this work. Live deployments, proven records, settlement-cost measurements and legal review remain gates, not implied by passing local tests.

**Current execution order (team direction, Nov 6): release the free pool first and add payments at the end.** Keep payments off for this release and preserve the existing payment implementation and verified Hoodi escrow for the later rollout. Independent-operator ENS onboarding is also deferred until the team supplies the operators' details. The free release can use the existing curated bootstrap operators, with mock ENS names explicitly labeled. Prioritize onion availability, the production gateway/public browser path, secure startup across committee periods, and the release documentation and demonstration. This changes delivery order; it does not mark the deferred payment or ENS requirements complete.

**Latest product workflow (Nov 6):** the team requested a complete operator health dashboard, selection or operator onboarding, an operator-controlled ENS subname containing multiple distributed endpoints, and adjustable per-query prices. They explicitly reconfirmed **free first, staking and payments later**, and clarified that traffic changes the **stake amount required per node**. [DEMO_WORKFLOW.md](DEMO_WORKFLOW.md) defines the flow, evidence labels and implementation gates. Minting is for operator identity, not a requirement for free readers. The curated ENS registrar uses expiring, non-transferable listings; M1-B adds a bounded endpoint list beneath each name without changing those ownership rules. Permissionless staking and unrestricted ownership remain unimplemented. Multiple endpoints owned by one operator provide redundancy, not independence.

**Planned ENS milestone (team request, Nov 6):** [M1 — ENS-managed private RPC operators](ENS_TOR_MILESTONE.md) turns that direction into two delivery checkpoints. M1-A demonstrates real proven discovery, restricted endpoint rotation and registrar delisting with two independent operators. M1-B adds several endpoints under one operator without increasing its selection weight. Both are required for the full milestone. Payments/staking stay off, independent-operator inputs and wallet signatures remain external gates, and a finalized verified refresh is required before claiming an on-chain change has affected the client. Planning this milestone does not mark it deployed or change the current registrar's ownership/curation rules.

The dashboard must distinguish recent local reachability, proven answers and ENS provenance. An eligible endpoint is merely available to try. Proofs do not certify future good behavior, and a stake is not proof of honesty. Anon-RPC runs in the consumer: the wrapper supplies the onion service and filtering proxy. Ordinary HTTP clients need an integrated DeRPC/anonymous transport and verifier to obtain those guarantees. The node still sees query contents; query-content privacy is not supplied by Tor.

**Automatic routing (team request, Nov 6):** `selection` chooses `balanced`, `fastest` or `reliable`; omitting it preserves the manual API. `allowedOperators` can restrict automatic routing to exact operator IDs/ENS names, and `[]` always closes the read pool. Categories use recent local verified outcomes, with bounded exploration, per-account affinity and sequential failover. They are preferences, not global speed/uptime guarantees. Unknown operators remain unknown. Raw unverified discovery calls do not train rankings. Automatic selection is free-only and does not select paid sessions, personal credentials or simulated corrupt operators. M1-B applies these categories to stable operator groups and then their eligible nodes; public multi-endpoint deployment remains a separate gate. The only supported `chainId` is 1. Arbitrary chains, cheapest-price routing and a separate privacy category remain later work.

Implemented and validated Nov 6: 350 provider tests and 149 frontend tests passed, with workspace type checking and the combined site build. A real Firefox check verified all five configured public endpoints individually at block 26356307. A second check exercised automatic categories, retained account affinity, empty-list refusal and an exact operator restriction at block 26356339, without direct RPC/beacon fallback. These used the local development gateway, not a new public deployment. Dated evidence and the scoped commit plan are in [DEMO_WORKFLOW.md](DEMO_WORKFLOW.md#automatic-routing-implementation-and-validation-nov-6).

**ENS/wrapper continuation, Nov 6:** bounded proven-directory authorization and its dashboard expiry state are implemented. Incomplete local execution aborts an ENS scan; proven reverts remain distinguishable from gas/resource limits. Known gateway/RPC conflicts are checked before candidate probes. The unsigned lifecycle tool now prepares/rechecks/verifies endpoint rotation, lease renewal (including expired active leases), and curator delisting without burning the token. Actual-code fork tests cover the allowed updates and denied role/record changes; no public ENS action was sent. The standalone threat model now exists. The integrated run passed **718 default tests** (59 contracts, 68 payments, 399 provider, 36 wrapper, 156 frontend), with five ENS fork tests separately passed, workspace type checks and the combined release build.

The latest [all-onion availability check](../wrapper/test/onion-availability-evidence-2026-11-06.json) verified consensus, identity, worker pin, balance and storage through the same wrapper onion at block **26356531**, then refused reads after shutdown, with no direct RPC/beacon fallback. Production timeouts were unchanged. The earlier diagnostic observed descriptor/rendezvous recovery before HTTP; it does not conclusively explain every historical timeout. This remains a same-party local gateway/demo-proxy observation, not the public-hosted release gate. The later M1-B implementation checkpoint is described below. Independent ENS enrollment, the public payment cycle and external reviews remain deferred/open.

**M1-B implementation checkpoint, Nov 6:** plural endpoint records, operator-first selection, node health/failover, complete-rotation owner/signer continuity, atomic permission migration, onboarding conversion and the lifecycle evidence display are implemented. General fully on-chain ENS resolution uses one bounded local EVM call and has nine offline checks against actual mainnet code/proofs. The combined working tree passed **1004 default tests**, five separate actual-code ENS fork tests, workspace type checking, the static-site build and the offline 46-file release check. These counts include the parallel release/diagnostics work. [OPERATIONS.md](OPERATIONS.md#multiple-endpoints-and-verified-ens-november-6) records evidence and commit boundaries; local implementation does not replace the public milestone gates.

The [live M1-B check](../wrapper/test/multiendpoint-evidence-2026-11-06.json) also passed at authenticated block 26356914: both temporary onion wrappers served, a forced failure recovered through the sibling, the account retained that sibling, and an explicitly added public operator supplied the later fallback through Tor. General ENS resolution verified the empty `derpc.eth` `url` record in 26.489 seconds using 14 proof and six code requests with no remote `eth_call`. Source hashes stayed unchanged and shutdown produced zero additional requests during observation. Warmups and earlier availability failures are disclosed. The operator name was mock, both proxies and the gateway were run by the tester, and no public ENS registration or directory lifecycle was performed.

Implementation now spans `contracts/`, `payments/`, `wrapper/`, the provider and the demo. ENS discovery proves the pinned registrar's list and payee and can execute resolver calls locally against proven state. The complete ENS deployment planner and receipt verifier passed five checks against actual mainnet contract bytecode on a local fork. No public operator subregistry or names have been deployed. App/agent delegation includes a Linux durable store, a coordinator that issues short-lived read authorizations after reserving user/session exposure, and a delegated-key browser SDK. Payment follows independent proof verification. Actual HTTP/wrapper/local-chain integration exercised caps, revocation, restart and settlement; the app escrow key never entered the delegated client. An app must supply its authenticated header/funding sources and deploy that service; this does not establish a conforming anonymous Node runtime. Production-chain choice, independent security review and legal review remain open; the readiness brief is not a completed review.

The user deployed the Hoodi escrow in transaction `0xb8b53eaebe08d00d8d9e976a6897be5f8e5b145fd59052ac6be7ed11b36a7955`, block 3962188. The [deployment manifest](../contracts/deployments/payment-hoodi-deployment-2026-11-06.json) and [second-source check](../contracts/deployments/payment-hoodi-crosscheck-2026-11-06.json) record the correct creator, canonical receipt, exact creation/runtime bytecode and 12 confirmations. This completes the public testnet deployment gate; it does not establish a paid session, mainnet ENS registration, independent contract review or light-client verification of Hoodi.

For the next ENS deployment, the user selected **independent operators** and will supply their public details. Do not substitute the locally run demo proxies for those registrations. Prepare the mainnet plans once 2–3 operators' ownership/record-management addresses, public onion endpoints, payment terms and fixed listing expiries are supplied. The existing `derpc.eth` owner remains the parent curator/deployer unless the team provides a different authorized arrangement; operator resolver administration and settlement keys stay with their respective operators.

Live Firefox evidence shows the real pinned tor-js worker fetching mainnet proofs and consensus data through the onion wrapper with no direct RPC/beacon requests. Local EVM execution successfully read `derpc.eth`'s existing ENSv2 proxy resolver at verified block 26355418; its empty `url` record is a valid result, not evidence of operator records. A follow-up three-record resolver multicall at block 26355450 passed in 25.294 seconds using nine proof and three code requests, with no upstream `eth_call`. Personal-token enforcement, unavailable-personal-node failover, identity mismatch rejection and fail-closed shutdown also passed. The single observed onion proof took 5.831 seconds versus 0.818 seconds through an exit; this is not a general latency comparison. An isolated encrypted restore regenerated both onion identities and recovered the personal token; owner-encrypted local backup archives were retained outside the repository. A Firefox personal-UI check found no credentials in observed host storage/log/HTTP surfaces. These do not claim off-device backup retention or general memory secrecy. Durable evidence and reproducible deployment steps are linked from [OPERATIONS.md](OPERATIONS.md).

Earlier expanded-scope validation, Nov 6: 507 default tests passed (40 contracts, 68 payments, 278 provider, 35 wrapper, 86 frontend), plus five opt-in tests separately passed against the actual ENS mainnet bytecode on a local fork. Workspace type checking, Solidity compilation and the combined static release build passed. These checks do not substitute for the public deployment receipts or external reviews above. A fresh-cache Firefox run also verified the final lifecycle patch with onion consensus and an explicitly selected execution endpoint through Tor, followed by shutdown refusal and no further calls during observation; the final all-onion execution attempts hit network deadlines.

## 5. Weekend scope (MVP)

Execution order: anonymous transport → verified reads → pool failover → integrator/demo UX → submission. Detailed gates and timeboxes are in [ROADMAP.md](ROADMAP.md).

- [ ] **Hour 6 go/no-go:** a real `eth_getProof` through a Tor or Nym worker (some RPCs block Tor exits).
- [ ] The light-client library routes its requests through `worker.fetch`, with no hosted prover and no checkpoint server.
- [ ] Verified header plus a proof-checked `eth_getBalance` and ERC-20 balance.
- [ ] Pinned bootstrap: answer `workerHash()` and `workerResolvers()` locally, then prove the hash slot through the worker against verified state before serving user reads. Reference notes place `workerHash` in slot 1; confirm the chosen deployment and chain. A mismatch or inability to verify stops initialization.
- [ ] User-chosen operators, local blocklist and bounded failover across at least two usable endpoints. Racing is deferred: it reveals the query to more operators and adds traffic.
- [ ] Provider/viem integration plus a small pool status screen; no required central backend.
- [ ] `THREAT_MODEL.md` and focused verification/failure tests. Per-file AI disclosure is required for submission; AI_USAGE.md records it, and attribution for code areas waits for the team's instruction.

### Demo (3 steps)

1. A browser app consumes the wallet-ready provider and shows a verified balance, selected endpoint and verified block.
2. Inject a clearly labeled corrupt response. The proof check fails, the response is rejected, the endpoint is excluded locally, and another endpoint supplies a verified result.
3. Kill the anonymity network. DeRPC fails closed and never makes direct RPC requests.

### ENSv2 operator registry (expanded Nov 6 scope)

The team explicitly included the complete ENS work after the core demo passed. Public deployment and operator configuration remain completion gates. Full prize requirements are in TRACKS.md.

- [ ] Operator registry under `derpc.eth` on **mainnet ENSv2** (decided Nov 6; `derpc.eth` is registered there, and the light client can't follow Sepolia), with 2–3 operator subnames carrying endpoint text records. Each operator has its own resolver, because ENSv2 resolver roles have no per-name scoping. Listings expire unless renewed.
- [ ] Demonstrate discovery against the deployed operator registry. The implementation proves the list/payee from the registrar layout and optionally proves records through bounded local execution of `resolve()`; the separate unverified discovery mode remains labeled. Revocation/expiry and user selection are covered locally; the live operator deployment is still missing.
- [ ] Optional demo step 4: revoke an operator, and it drops out of the pool for every user.

## 6. Threat model (summary)

The standalone [threat model](../THREAT_MODEL.md) records assets, trust boundaries, controls, credential exposure and remaining evidence gates across the provider, ENS, wrapper and payment system.

- **Lies about data:** supported reads are checked against fresh, verified state. Local exclusion is defensive; unsigned responses do not establish public blame against an operator when the worker can also tamper.
- **Downtime, censorship or slowness:** route around it. It can't be proven, so it is never slashed.
- **Spying on queries:** anonymous routing aims to hide the client's IP from the RPC endpoint, but query content and timing remain visible. Account separation depends on the deployed worker and cannot be assumed from isolation keys. Spreading queries does not guarantee unlinkability against colluding operators.
- **Sybils:** in the free release the operator list is curated. The requested later staking model imposes an identity/node cost, not proof of unique ownership. Multi-endpoint selection must not give an operator more weight simply for publishing more URLs.
- **Root of trust:** the pinned checkpoint, shown in the UI and refused if stale.

Target claim, once tested: **"RPC reads routed anonymously, supported answers verified, query content visible to the node."** Describe isolation guarantees only to the extent demonstrated by the deployed worker. Bundle loading and transport setup are disclosed separately from RPC reads.

Don't say "any home node is as trustworthy as Infura" without qualifying it. Say it only **for provable reads**.

Pitch line: **"You don't need to trust operators for correctness; you only need to limit what they can learn about you."** Cryptography enforces correctness, routing around failures handles availability, and keeping each operator's view small protects privacy.

Raw `eth_call` answers are never treated as proof. Generic calls are refused by default; the optional local EVM executes against mainnet account, code and storage proofs anchored to authenticated execution context. Unsupported history/context and off-chain lookups fail closed. Logs remain unsupported. Two operators agreeing is not proof.

## 7. Road to decentralization (roadmap)

Build priorities, acceptance gates and scheduling live in [ROADMAP.md](ROADMAP.md). The first release is a client-side pool with curated discovery; it is not a permissionless operator economy.

| Step | What | Needs |
|---|---|---|
| 0 | Private, verified RPC pool (this weekend) | Anonymous transport, light client, proofs, local failover and a small demo |
| 1 | Wallet/app adoption | Stable provider interface, an external integration and measured performance; Kohaku is the first candidate |
| 2 | Server-side agents | A suitable isolated runtime, actual anonymous traffic and the same verification/failure guarantees |
| 3 | More EVM chains | Per-chain authenticated roots, proofs, finality rules and tested endpoints; transport compatibility alone is insufficient |
| 4 | Distributed operator discovery | A replaceable registry with explicit governance. Curated, unstaked ENSv2 remains the day-2 stretch; permissionless registration needs Sybil resistance. **Team direction (Nov 5):** an ENS list of operators, where each operator mints a subname of the main domain as proof of service and users pick their operators themselves. The choice is built with mock names; real subnames are still to do (ROADMAP.md, "To do: user-chosen operators from an ENS list"). **Plan (Nov 6):** mainnet ENSv2 under `derpc.eth` (registered), in the steps of ROADMAP.md, "Gated stretch: ENS operator registry" (#12, #44–#49). |
| 5 | Client-side scoring and selection | Local success/latency measurements, random exploration and concentration limits. Published probes are hints, not authority; their traffic patterns may still be identifiable. |
| 6 | Signed accountability | Responses bound to operator, request, chain and block; independently verifiable evidence and dispute rules before penalties |
| 7 | Operator economics, after the free release | Team-requested operator identity stake, traffic-dependent per-node stake and configurable per-query prices. Economic rules and safe multi-node accounting remain to design; staking never replaces proofs. |
| 8 | Richer verified reads and query-content privacy | Local EVM execution against proven state; PIR research, including private proof retrieval |

Beyond code: operators that support `eth_getProof`, wallet adoption (Kohaku first, then Kiwi News and Privacy Pools), standards work on Ethereum Magicians, grant funding (no token), and legal review before payments.

## 8. Research done

- **Anon-RPC repo:** read the README, SPEC, implementation README and adopters list. Cloned to `reference/anon-rpc/` (gitignored, `c8980fb`, spec v0.4.0). Notes and design findings are in [ANON_RPC.md](ANON_RPC.md).
- **Claude conversation** (claude.ai/share/c6d920ea-7249-41e0-ab73-a448c02920dd). The full text is in [prompts/2026-11-05-claude-planning-conversation.md](prompts/2026-11-05-claude-planning-conversation.md). Its claims are sourced to PRs and docs but not re-checked by us:
  - **Target user:** wallet integrators, Kohaku first. Kohaku already has ethers, viem, helios and colibri backends, and an anon-rpc backend is in progress (kohaku PR #271). A combined private-and-verified backend is the "ships after the hackathon" story.
  - **`@lodestar/prover`** wraps an existing provider. `eth_getBalance` and `eth_getCode` are marked done, but **`eth_getStorageAt` was still to do**. ERC-20 balances need storage proofs, so we may have to verify those ourselves. Helios's JS package takes separate execution and consensus URLs, so routing it through `worker.fetch` probably means patching its fetch (unconfirmed).
  - **isolationKey in tor-js:** a test saw five requests for five addresses leave through **one** exit. tor-js PR #17 adds per-key circuit isolation.
  - **Warm-up:** Kiwi News starts the worker early, while the browser is idle (anon-rpc PR #13). Do the same and show boot progress.
  - **Related work to position against:** Helios, Kohaku-style wallets, Shima, RPC AVS. Our difference: Anon-RPC-native and fail-closed. Check Shima and RPC AVS before citing them.
  - **Scoring design (roadmap step 5):** see the §7 table.
  - Recommended a host-side wrapper over a worker. Suggested Lodestar prover or Colibri. Measured tor-js at about 20s to start and about 1.9s per call (Kohaku benchmark).
  - Flagged the bootstrap read as a security gap, recommended isolation keys, and noted the EF workshop with Andrew Morris. **Verified on the prize page: 5:00 PM IST, Thu Nov 5, Workshop Room 2.** It was already under way when the conversation ended (about 5:35 PM IST), so follow up with the EF team at their booth.
  - Defined the 6 requirements for a decentralized RPC pool: verifiable answers, discovery, client-side selection, payment, accountability, Sybil resistance. Anon-RPC covers none of them fully; it only provides request privacy.
  - Wrote prompts for Grok on X (projects landscape) and a research-theory prompt (mechanisms, not products).
- **Grok chat (the MumballyETH assistant, Oct 29 – Nov 5).** The full text is in [prompts/2026-11-05-grok-planning-chat.md](prompts/2026-11-05-grok-planning-chat.md). **Review it before the repo goes public**, because it mentions work context and links to private chats.
  - **How the idea got here** (the answer to "what inspired your project?"):
    1. Openlist, an RPC directory.
    2. A Dshackle-style privacy router.
    3. A staked operator marketplace with x402 payments and slashing.
    4. Independent ChatGPT and Claude reviews, which both said "drop the operator economy, make verification the product".
    5. A further narrowing after the EF mentor's feedback.
  - **Review points we keep:**
    - The client must run on the user's own device. A router hosted by someone else sees everything.
    - Only a failed proof counts as evidence. Nodes disagreeing, or a majority vote, doesn't.
    - Asking several operators per read increases traffic and shows each query to more operators; any latency effect depends on whether requests run concurrently or sequentially.
    - Hedera x402 uses fixed "exact" payments, not lottery tickets.
  - **Name:** DeRPC was picked from about 70 candidates. Tagline: "private, verified RPC from any node". dRPC is probably an existing RPC provider, so check for confusion.
  - **Q&A to prepare:** "Why not Pocket or Lava?" and "What if Anon-RPC goes down?" (see SUBMISSION.md).
  - **Build from scratch:** no Dshackle fork, and no code from the team's other work.
- **Mapped theory to the build:**
  - Build: light client plus proofs and sequential anonymous failover. Racing is deferred.
  - Stretch: `eth_call` via local EVM execution against proven state.
  - Roadmap: ZK usage credits, sharded PIR, signed responses with disputes.
  - Skip: Verkle, TEEs, ORAM.
- Found errors in the research reports (dual staking misfiled, skim not trustless, Verkle versus the EIP-7864 binary tree) and listed sources not yet opened. **Don't cite those until checked.**
- **Reading list:** the Ethereum privacy roadmap ("Private reads" section), the trust-minimized transaction simulation post plus the Colibri reply, Sharded PIR (sections 1, 2 and 8.1), and ZK API Usage Credits.

## 9. Open questions

- Colibri or Lodestar prover: which one can route requests through `worker.fetch`? Also, does `@lodestar/prover` verify `eth_getStorageAt` yet? The planning conversation said it was still to do, and ERC-20 balances depend on it.
  - **Tested Nov 5.** Setup: Node 24, mainnet, direct connection (no Tor yet), an injected logging `fetch`, the global `fetch` wrapped to catch any bypass, a pinned checkpoint, and no prover or checkpoint servers.
  - **Lodestar light client 1.43.0: works.**
    - It synced in about 1 s from the pinned checkpoint, using 2 requests (light-client bootstrap and optimistic update).
    - All requests went through the injected `fetch`, and none bypassed it. **Correction (later on Nov 5):** that test only wrapped `fetch`. `Lightclient.start()` then subscribes to the beacon node's **Server-Sent Events stream**, which opens its own connection outside the injected fetch and would leak the user's IP. DeRPC now uses its own transport that polls for head updates instead (`provider/src/light-client/polling-transport.ts`, with a test that fails if the event stream is opened).
    - **In the browser** (#4 done): headless Firefox, through tor-js and our gateway. Ready 4.2 s after the worker, 4 beacon requests, all through the worker. The finalized header advanced past the pin within 15 s. Browser needs: a BLS alias to the WASM build (`@chainsafe/bls/herumi`, in `frontend/vite.config.ts`), plus a minimal `process` and a Buffer polyfill (`provider/src/runtime/node-globals.ts`).
    - **Verified reads** (#5 done): our own EIP-1186 verifier (strict RLP, Merkle-Patricia walk, account/storage/code checks; values derived from the proof, claims must match). Live in headless Firefox through tor-js: 2,082,568.11 ETH in the WETH contract, 4,276.84 WETH in the Uniswap V2 USDC/WETH pair, and WETH's code, all proven at the verified block in 1–2.6 s each. 43 tests. Mutation checks confirmed every security guard is covered; one gap found and closed (a truncated proof dressed up as "account doesn't exist").
    - **Pool and failover** (P3 done: #7, #8, #14, #15).
      - It picks randomly in the best eligible tier, one attempt at a time. **Changed later on Nov 5:** the pool holds only the operators the user chose, and each account stays with the operator that first served it (it moves only on failure).
      - An invalid proof excludes the endpoint locally; transient failures give a cooldown.
      - Retries use another endpoint and a fresh Tor circuit (a derived key for the same account), with at most 3 attempts and 30 s.
      - It never retries stale-header, pin or dead-transport errors, and it caches verified results per verified block. 68 tests.
      - **Three-step demo, live in Firefox through Tor:** (1) verified reads; (2) the simulated lying node was rejected and excluded, and the same balance (2,083,327.46 ETH) came from BlockRazor; (3) after cutting the network, every read failed with `TransportUnavailableError` and nothing went direct.
      - **Retry change (P4 live test):** with two chosen operators, one Tor exit failure each left nothing to try for 60 s, and a read failed. Now, when no fresh operator is left, the pool gives a resting (not excluded) one another try on a fresh circuit, and a success ends its cooldown. Invalid proofs still exclude for the session.
      - #14 repro attempt: 20 repeated same-key requests (dRPC and check.torproject.org), 20 succeeded. The key kept one exit for 8 requests, then tor-js rotated the circuit. With no failure, the harness's error fields couldn't be inspected; the pool treats untyped errors as transient anyway.
    - Its verified finalized state root matched an independent RPC.
    - **Nov 6 integration fixes:** RPC and beacon adapters share a bounded stream reader: one per-request deadline across headers and body, a 16 MiB body cap, cancellation on timeout/abort/oversize responses, and listener cleanup. Nov 6 pool integration adds a total deadline, cancellation of in-flight work, observer isolation, and return-time freshness checks before results or vouchers. Beacon startup rotates through all configured endpoints within a total budget; abandoned fetches and pollers are canceled. The pinned Lodestar patch also makes stop terminal during synchronization and retry sleeps, preserving the earlier finality/forced-update fixes. Removing a personal node removes its retained execution and beacon credentials. Optimistic and finality poll failures are tracked independently and reset only after that kind succeeds; repeated rejected updates no longer reset the count. The combined header source preserves return-time freshness checks and bootstrap epoch binding, and the transport keeps log-queue worker-death detection even without a log callback.
      - Validation: 158 provider tests and 74 frontend tests passed, along with type checking and the combined static build. In Chromium through the local gateway, worker startup took 4.1 s and header verification another 6.8 s. ETH, WETH storage and code reads verified at block 26353949; the simulated corrupt balance was rejected and excluded, then succeeded through another chosen operator. Closing the worker refused every subsequent state read. The page's direct-connection table showed only local assets and the worker CDN, and the browser trace showed no direct requests to the selected execution operators.
    - Caveats:
      - Lodestar itself is active (v1.50.1, Oct 22 2026). But in May 2026 its team **moved the light client and prover out of the monorepo** (ChainSafe/lodestar PR #9346; issue #8892 calls them "not very useful for us"). They now live in `ChainSafe/lodestar-prover`, which has a single initial commit (May 14), no releases and no activity since. npm stays at 1.43.0. So it works today (Fulu supported), but nobody is maintaining it, and a future fork would need someone to update it.
      - An npm install needs pinning: exact `@lodestar/*` 1.43.0, `@chainsafe/ssz` **1.7.0 or older** (1.8 and later throws "List limit must be a positive integer"), and a stub for `@lodestar/spec-test-util`, whose published package contains `vitest: "catalog:"`.
      - **Known security bug, unpatched in 1.43.0.** Lodestar fixed it in core on Jul 24, 2026 (PR #9419), after the light client had moved out.
        - The bug: `isZeroedHeader` only checks `bodyRoot`, and the finalized header gets overwritten without checking that the update is a finality update.
        - The impact: a malicious or man-in-the-middle beacon endpoint could plant a fake finalized header, and with it a fake state root. That's exactly what DeRPC must prevent. We confirmed the loose check in the installed 1.43.0 code.
        - Fix: backport #9419 as a local patch (two functions and one guard), plus a regression test that replays the attack.
      - **No Gloas (Glamsterdam) support.** Gloas light-client support exists only in Lodestar core (PR #9687, Sep 2026).
        - Sepolia switched to Gloas at epoch 353024, about a month ago, so 1.43.0 can't follow Sepolia. Tested: "Offset out of bounds" when decoding the new bootstrap format.
        - **Mainnet and Hoodi both work (tested Nov 5),** since both are still on Fulu. For Hoodi, publicnode's beacon has no bootstrap data; `lodestar-hoodi.chainsafe.io` works.
        - Mainnet has no Gloas date yet: the live fork schedule ends at Fulu, and Lodestar v1.50.1 schedules none. Once it gets one, 1.43.0 stops working until it's replaced.
      - `@lodestar/prover` still marks `eth_getStorageAt` as not done (⌛).
  - **Colibri 3.0.3: has an official `fetch` option**, and nothing bypassed it.
    - **Local mode failed:**
      - publicnode beacon: "invalid body root for cl proof".
      - ChainSafe beacon: HTTP 429.
    - Local mode downloads full beacon blocks; the light-client endpoints alone aren't enough.
    - It works best with its hosted prover (`colibri-proof.tech`), which our requirements exclude.
  - **Helios 0.12.0: no `fetch` option.** Its WASM calls the global `fetch`, so routing it through the worker would mean patching `fetch` for the whole page. Not tested further.
- Does the EF team want the bootstrap read proven, and do they want a host-side verifier?
- **Bootstrap implementation (ANON_RPC.md, finding 3):** the plan is to pin the hash and resolvers locally, then verify the hash slot through the worker before serving user reads. Confirm the full pin, deployment/storage layout, checkpoint freshness and specifier-chain verifier; discuss the design with EF.
- Does tor-js honor `isolationKey` (separate circuits per key)? The "accounts unlinkable" claim depends on it. An earlier test saw five addresses leave through one exit. PR #17 was closed, but per-key isolation shipped in **tor-js 0.4.4** (changelog, Oct 29), which is the version the mainnet contract pins (`0x5b62…`). It's documented, but not yet observed; P1 step 6 checks it.
- tor-js needs a KPS gateway, and the demo one may disappear. Run our own, or keep Nym as the demo backup?
- Which **public keyless** RPC endpoints support `eth_getProof` and accept Tor exits? **Partly answered (direct test, Nov 5, mainnet, no Tor yet):**
  - **Execution, `eth_getProof` at the finalized block works:** `ethereum-rpc.publicnode.com`, `eth.drpc.org`, `rpc.mevblocker.io`, `eth-mainnet.public.blastapi.io`, `eth.blockrazor.xyz`. All five return CORS headers and passed a 20-request burst. A proof for one account plus one storage slot is about 14 KB.
  - **Latest block only** (finalized is outside their proof window): `mainnet.gateway.tenderly.co`. `1rpc.io` and `rpc.flashbots.net` failed for finalized and errored on latest.
  - **Unusable keyless:** Ankr (needs a key), Nodies (no `eth_getProof` on the free plan), Cloudflare (errors), LlamaRPC (HTTP 525), Merkle (rate-limited at once), payload.de (DNS failure).
  - **Beacon light-client API (bootstrap, updates, finality and optimistic updates):** `ethereum-beacon-api.publicnode.com` and `lodestar-mainnet.chainsafe.io` both work, with CORS. `www.lightclientdata.org` returned 503.
  - **Published limits:** only two providers publish numbers.
    - dRPC's free public nodes: about 120,000 compute units per minute per IP (around 100 `eth_call`/s), which can drop to about 50,400 under load. Batches are capped at 3 requests and timeouts at 2 s. Older docs say 315,000.
    - Blast public endpoints: 25 requests/s (a 2022 post).
    - publicnode, MEV Blocker, BlockRazor and the ChainSafe Lodestar beacon don't publish limits.
    - No endpoint returned rate-limit headers.
  - **Risks for P1:**
    - Every working execution endpoint, and the publicnode beacon, sits behind **Cloudflare**, which may challenge or block Tor exits. The Lodestar beacon (nginx) is the only one not behind Cloudflare.
    - Per-IP limits apply to the **Tor exit's IP**, which other Tor users share. Separate circuits per isolation key help.
    - DeRPC's own traffic is small: one `eth_getProof` per read, plus light-client updates.
  - **P1 passed (Nov 5).** Setup: headless Firefox, the real tor-js 0.4.4 worker on the demo gateway, and the pinned bootstrap (no RPC at boot).
    - Boot took 6.6 s, much faster than the earlier ~20 s benchmark.
    - Every check reported `IsTor=true` from check.torproject.org.
    - **`eth_getProof` at the finalized block through Tor works on** dRPC, MEV Blocker, BlockRazor and Blast. Each proof was 13.7 KB and took 0.9–2.6 s. Cloudflare didn't block them.
    - publicnode **failed through Tor** ("distance to target block exceeds maximum proof window"), although it worked directly. Treat it as unreliable for proofs.
    - **Light-client data through Tor works on both beacon endpoints:** bootstrap 53 KB, optimistic update about 2.4 KB, about 1–1.6 s each.
    - The page's own direct connections were page assets, plus one bundle download from cdn.jsdelivr.net. There were no direct RPC or beacon requests. The WebRTC link to the gateway isn't visible in resource timing.
    - Isolation: two keys used two different exits, consistently, over 4 requests. That's an observation, not proof.
    - One request failed transiently (TLS reset at the exit). Retrying under a new key or another endpoint is the plan (P3).
  - **Team's own Firefox run (Nov 5), with the same results, plus these issues:**
    - **Boot took 49 s.** The fast-bootstrap dial to the demo gateway timed out after 15 s, so tor-js downloaded the full Tor directory itself (about 9,600 microdescriptors). Later reloads should hit the cached directory.
    - **The demo gateway warns** that it's "a demo instance: limited capacity… may disappear". It's a single point of failure for the demo.
    - **An intermittent `CONNRESET` during the TLS handshake**: 1 of 4 checks in both runs, each time on the *second* request under an isolation key to the same host. DeRPC repeats requests to the same host under one key all the time, so P2/P3 must test this and treat it as retryable.
    - **Likely cause, from a third occurrence (team's run through our gateway):** the key's first request was slow (6.5 s, exit 185.220.101.178), and its second timed out at the exit ("Timed out while waiting for answer from exit"). So a **bad exit or circuit gets reused under the same key**. tor-js's README says a failing circuit can keep failing for minutes, while a new `isolationKey` gets a new circuit.
    - **P3 retry policy:** on exit-side failures, retry on a fresh circuit for the same account (a rotated, derived isolation key) and/or another endpoint. Never retry direct.
    - publicnode's proof failure through Tor happened again (drop it from the execution pool). Blast varied from 2.6 to 4.8 s.
    - Harmless: tor-js memory-quota warnings (normal in WASM) and one directory "Partial response" retry.
  - **Own gateway (Nov 5).** `tor-js-gateway` 0.3.0, built from v0.4.4, running locally at `10.116.160.42:12298:uEiARDl43WpoGkqnWR0ni76c0Q8XNKq8-NH5afe5MpllWLw`.
    - It synced the Tor directory in 26 s and serves a 1.46 MB fast-bootstrap snapshot.
    - It mirrors the hash-addressed worker bundles, including our pinned `5b62f358…`.
    - Headless Firefox through it: **worker boot 3.0 s, 16/16 checks passed**, no `CONNRESET`, no demo warning. publicnode's proof worked this time, so it's flaky through Tor rather than broken.
    - Build note: linking needs `libsqlite3.so`. Without `sqlite-devel`, link with `LIBRARY_PATH` pointing at a symlink to `/usr/lib64/libsqlite3.so.0`.
    - **Exposure:** it listens on UDP 12298 on all interfaces, including a global IPv6 address. Fedora Workstation's default firewall zone allows 1025–65535/udp, so it's reachable from the LAN and possibly over IPv6. It only tunnels to consensus-listed Tor relays (16 tunnels per IP), but stop it when it isn't needed. A firewall rule is the team's call.
- Nym or Nox startup times (only tor-js has been measured).
- Wallets and viem ask for `"latest"` by default, and DeRPC refuses it (it can only prove the finalized block). Should DeRPC offer an explicit, labeled opt-in that answers `"latest"` with the verified finalized state, for integrators like Kohaku?
- ENSv2 (stretch): which storage slots hold the Permissioned Resolver's text records, so they can be proven with `eth_getProof`? Is ENSv2 fully on Sepolia? What's the best way to list operator subnames (an index record on the parent)? The ENS workshop (4:00 PM IST, Nov 5) has passed, so ask at the ENS booth.
  - **Checked Nov 6.**
    - ENSv2 is in use on mainnet: its `.eth` registry (`0xf60aba43e1f7f3dab1186ff03b561401c9df85e2`) and registrar emitted thousands of events in a day. The ENS deployments page still says "deployed ahead of the launch"; it's a snapshot of an older commit.
    - `derpc.eth` is registered there, with an owner and a resolver and no subregistry yet. So the registry goes on mainnet, not Sepolia.
    - The ENSv2 docs don't describe storage layouts or proofs. The Permissioned Resolver is an upgradeable proxy with no standalone getters (records are read through `resolve(name, data)`), its roles have no per-name scoping, and the registry has no function to list names.
    - **Implemented and tested Nov 6:** local EVM execution follows the resolver proxy using proven code/storage, avoiding an assumed resolver layout. The curated registrar controls active membership and expiry with a documented three-slot layout. Zero-role names are accepted by the actual ENS bytecode; factory provenance, exact roles, renewals and the complete deployment/receipt workflow passed on a mainnet fork. See `contracts/deployments/ens-fork-evidence.json`. Public deployment is still pending.
- Demo network: mainnet with the recorded Tor/Nym specifiers, or Sepolia with a compatible Sepolia specifier? **With the Lodestar 1.43.0 light client, Sepolia is ruled out:** Sepolia already runs Gloas, which 1.43.0 doesn't support. Mainnet and Hoodi work, but the worker contracts and the ENS prize point to mainnet. Sepolia queries alone do not remove the need to verify a mainnet specifier. Resolve in P0 without allowing ENS to expand the core scope.
- Is "DeRPC" free on GitHub and npm, and is it too close to dRPC, an existing RPC provider?
- ~~Are the prize amounts correct?~~ Verified: Anon-RPC pays $2,500 / $1,500 / $1,000, and CROPS pays $2,000 / $1,000 / $500.

## 10. Hackathon rules checklist

Full rules are in [SUBMISSION.md](SUBMISSION.md).

- [ ] Submit on the Hacker Dashboard by **Sat Nov 7, 09:00 IST**. No late submissions.
- [ ] All code written after the start, with frequent commits (no big single commits) and no reused repos. Name any open-source libraries or starter kits used.
- [ ] AI use documented **per file**: which code, files or assets were generated or assisted by AI. Keep prompts and spec files in the repo.
- [ ] Partner prizes: up to 3 picks, and a partner with several tracks counts as one. EF (Anon-RPC and CROPS) is pick 1, ENS is pick 2 if the stretch ships. Each pick needs a note on how we used their tools, plus feedback.
- [ ] Optional demo video: 2–4 min, at least 720p, no AI voice, not sped up, not recorded on a phone, no music-with-text. **Keep it 2–3 min**, because CROPS caps it at 3.
- [ ] Finals: 4-minute demo plus 3 minutes of Q&A. Judged on technicality, originality, practicality, usability and WOW factor.

## 11. Prize requirements (from TRACKS.md)

Anon-RPC judging: works end to end, UX quality, **share of traffic through Anon-RPC**, shippable after the hackathon, technical depth.

- [ ] Every network RPC/consensus read goes through Anon-RPC. Bootstrap hash/resolver calls are answered locally from pins; later hash-slot verification goes through the worker. Checkpoints are pinned, with no hidden direct fetch.
- [ ] Explain the method boundary: raw `eth_call` responses carry no proof; the optional local EVM verifies bounded mainnet calls against proven state and rejects unsupported context/history. Generic calls remain disabled by default.
- [ ] The README has a **CROPS** section with C / O / P / S, one or two lines each (see TRACKS.md).
- [ ] The demo video shows the moment the lead property matters: swap in a lying RPC, then kill the network.
- [ ] No third-party trackers or analytics in the client. Keys and data stay on the device.
- [ ] Repo is public under MIT (already licensed).
