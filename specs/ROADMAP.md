# DeRPC roadmap

Planning baseline: Nov 5, 2026; implementation evidence updated Nov 6. Checkboxes and the status table distinguish verified work from outstanding deployment gates. [CONTEXT.md](CONTEXT.md) remains the source of truth for decisions; this file defines execution order and completion gates.

Track implementation in [GitHub issue #1](https://github.com/r0bops/DeRPC/issues/1). Start with [the light-client choice](https://github.com/r0bops/DeRPC/issues/2), then [a real anonymous proof request](https://github.com/r0bops/DeRPC/issues/3). Issues hold progress and implementation discussion; keep priorities and scope here.

**Product:** a decentralized RPC pool for apps, wallets and agents, starting with Ethereum. Requests travel through Anon-RPC; the client verifies supported reads and selects or switches endpoints locally. The first release uses curated discovery. There is no required central DeRPC proxy.

**First customer:** a wallet integrator. Demonstrate the same provider in a browser app. Server-side agents and additional EVM chains follow once their runtime and verification paths are tested. The explorer-style screen explains the pool; a full RPC directory is outside the MVP.

**Nov 6 execution update:** the team requested all ENS/operator/payment issues #44–62, including #48, #61 and #62. Contracts, wrapper, payment client, discovery, local EVM and demo controls are implemented and under final integration validation. Do not interpret the earlier after-hackathon labels as a scope exclusion for this work. Completion still requires the evidence in each issue, including live transactions and external review where specified.

**Latest team priority: keep the free pool live; add payments at the end.** The public mainnet alpha and ENS/IPNS website passed the recorded hosted checks. ENS onboarding remains deferred while independent operators' details are collected. Keep the payment implementation and deployed Hoodi escrow available for later work. Current priorities are:

1. **Local all-onion check passed Nov 6:** current-source consensus/identity/pin/balance/storage/shutdown succeeded at block 26356531 with existing budgets. A separate diagnostic observed descriptor/rendezvous recovery before HTTP. Keep the public-hosted and sustained-availability limits explicit (#49).
2. **VPS deployed Nov 6:** use `derpc.eth.limo` with IPFS; Vercel remains removed. Persistent gateway/IPFS services run on `45.76.81.48`. A fresh IPFS node retrieved all 55 release files with matching hashes, and Firefox passed verified reads, pin checks and shutdown through the public VPS using local IPFS site delivery. Release builds now use only the explicit gateway list. The owner-signed ENS contenthash update is confirmed; all 55 HTTPS assets match and a fresh Firefox run on `derpc.eth.limo` passed all 17 gates. See [deployment evidence and unsigned transaction](OPERATIONS.md#public-mainnet-alpha-november-6).
3. **Committee-period cold start passed Nov 6 at 19:54 UTC (#27):** fresh Firefox accepted a period-1904 signed head from the unchanged period-1903 checkpoint, with forced updates disabled, and verified the worker pin and balance at block 26357966. [Dated evidence](../provider/test/light-client/period-1904-evidence-2026-11-06.json) records the authenticated committee transition, no direct HTTP RPC/beacon requests and shutdown refusal. Keep a trusted recent checkpoint in subsequent releases; this local-gateway pass does not clear public hosting.
4. Maintain the live free release: observe an IPNS renewal cycle, arrange a second persistent pin and off-host IPFS recovery, and refresh the trusted checkpoint before November 12 at 17:07:35 UTC. Keep mock-name and demo-ownership labels explicit.
5. Preserve the standalone threat model, reproducible release instructions, demo/submission material and focused team-owned commits (#11). The existing release evidence does not establish sustained uptime or production readiness.

The later 19:27 UTC branch review reproduced #35's network-outage attribution failure on main, together with #38's mutable cache and #39's conflicting block selectors. Focused fixes and regressions for those findings are now integrated on updated `main`; retain them in release validation. #34 remains a startup regression case. See [QA_REPORT.md](QA_REPORT.md#branch-integration-review--november-6-1927-utc).

**Stable website pointer activated Nov 6:** a dedicated IPNS name resolves to
the existing release; signature validation and encrypted-key restoration passed.
Two RPC sources confirmed the owner's one-time ENS switch, and all 55 HTTPS files
match with IPNS gateway headers. See [migration evidence](../web/ens-ipns-publication-2026-11-06.json).
Automatic renewal is configured, not yet observed over a complete cycle. The
release workflow now requests IPNS publication through the restricted VPS handler
after package, pin and public-content checks. See [the runbook](../scripts/vps/IPNS.md).

## Operator dashboard workflow (latest Nov 6 direction)

The team reconfirmed free-first delivery and requested one operator ENS identity with multiple distributed endpoints, an operator dashboard, onboarding, and later adjustable per-query prices plus operator/node staking. Traffic changes the stake **required per node**; it does not merely limit node count. The full definition and acceptance gates are in [DEMO_WORKFLOW.md](DEMO_WORKFLOW.md).

- Free UI: show every listed operator, explicit selection, endpoint, identity provenance, observed local health and proof results; untested is unknown. Prepare a local multi-node onboarding draft, with staking and pricing labeled planned.
- Automatic routing (Nov 6 direction): add explicit balanced, fastest and reliable modes alongside manual selection. An omitted allowlist means all eligible free candidates; an empty list means none. Start with the five labeled bootstrap entries; expand from ENS only after proving both membership and records. Preserve account affinity, bounded sequential retries, exclusions and mainnet-only verification. Local ranking never certifies operator honesty or global performance.
  - **Implemented and checked Nov 6:** 350 provider and 149 frontend tests; all five bootstrap endpoints verified individually through Tor, followed by live automatic categories, account affinity, empty-list refusal and exact restriction. See [dated routing evidence](DEMO_WORKFLOW.md#automatic-routing-implementation-and-validation-nov-6). This does not complete independent ENS enrollment or live multi-endpoint identity lifecycle validation.
- M1-B implementation is tested locally: separate operator and endpoint IDs, a bounded plural endpoint record, atomic resolver-permission migration, operator-first selection, grouped UI and onboarding conversion. Multiple URLs do not multiply an operator's weight. Actual independent-operator deployment remains deferred; local/fork validation is recorded in [OPERATIONS.md](OPERATIONS.md#multiple-endpoints-and-verified-ens-november-6).
- Public release checks passed; deployment maintenance remains above. Independent ENS enrollment retains its gates. Drafts are not registrations; current curated listings expire and are non-transferable.
- Economics last: specify traffic measurements/formula, asset, amounts, withdrawal and any accountability rules before staking implementation. Existing per-query escrow is not a staking contract. Multiple wrappers need explicit paid-session accounting; do not share single-writer journals or silently reuse funded sessions across endpoints.

## Nov 6 implementation and remaining gates

The next ENS-specific deliverable is [M1 — ENS-managed private RPC operators](ENS_TOR_MILESTONE.md). Its work packages reuse #44–55, with #13/#27 anonymous-path prerequisites and #11 release evidence. Deliver M1-A (proven discovery, restricted rotation and delisting) before M1-B (multiple endpoints per operator); both checkpoints are required for M1 completion. Contract/tooling, wrapper/gateway, provider and UI work may proceed in parallel once schema/API ownership is agreed. Public enrollment remains dependent on the team's independent-operator inputs. Staking and payments are outside this milestone.

The Nov 6 continuation completed bounded directory-snapshot authorization and dashboard expiry handling, incomplete-scan refusal, pre-probe gateway separation, unsigned lifecycle plans/receipt verification and actual-code lifecycle fork checks. The later M1-B checkpoint adds multi-node runtime/tooling, general fully on-chain ENS resolution and a dashboard comparison between imported lifecycle receipts and fresh proven directory state. The standalone [threat model](../THREAT_MODEL.md) is written. Validation and scoped commit groups are in [OPERATIONS.md](OPERATIONS.md#multiple-endpoints-and-verified-ens-november-6). These local implementation checks do not complete independent enrollment or a finalized public ENS lifecycle.

| Issues | Evidence obtained | Still required |
|---|---|---|
| #44–47 ENS | Curated registrar, scoped resolver/deployment plans, complete discovery and proven storage layout; five real-code mainnet-fork checks including deployment/receipt verification | Mainnet wallet signatures, 2–3 real operator configurations, public receipts/pins and live revocation demonstration |
| #48 verified calls | Bounded mainnet EVM with authenticated context and account/code/storage proofs; real ENSv2 proxy read through Tor; 56 execution tests and Firefox bundle measurement | Published operator records to demonstrate the complete directory path; broad RPC compatibility is not claimed |
| #49–55 wrapper | Filtering, beacon routes, setup, identity, separate personal service; real onion reads, authentication/failover and shutdown tested in Firefox | Publish actual endpoint/gateway records with ENS; current live evidence explicitly uses a same-party demo proxy |
| #56–60 payments | Immutable escrow deployed on Hoodi with a checked receipt/runtime and 12 confirmations; post-verification vouchers, durable wrapper close, ENS term handling and demo panel; actual local HTTP/provider and Docker restart/settlement checks | Published operator terms, wallet-funded anonymous browser session and public closing/refund receipts |
| #61 app/agent budgets | Delegated read authorization, durable user/session exposure, independent proof completion and terminal admin settlement; actual HTTP/wrapper/local-chain integration and crash tests passed | Application deployment with a funded session, protected key, authenticated headers/funding, grants and ingress |
| #62 real funds | Test-chain restrictions, provable payee, local gas measurements and an operations/review brief | Measured public settlement costs, a production chain/asset decision, independent security review and legal review |

The test escrow is deployed on **Hoodi (560048)** at `0x9053513aCA73bAc0aF6a9942fd93832fd313B0bb`; its reviewed creation bytecode and runtime were checked through two administrative RPC sources at 12 confirmations. Sepolia escrow is supported too, despite being unsupported by the pinned read light client. ENS and verified reads remain on Ethereum mainnet. Public ENS deployment, the paid session demonstration and external reviews remain pending. See [OPERATIONS.md](OPERATIONS.md) for the manifest and remaining gates.

## Focus order

| Priority | Deliverable | Completion gate | Issues |
|---|---|---|---|
| P0 | Resolve the transport, verifier and chain choices | One viable browser integration path, with explicit trust assumptions | [#2](https://github.com/r0bops/DeRPC/issues/2) |
| P1 | Real anonymous network access | A live `eth_getProof` and the required consensus data arrive through the worker | [#3](https://github.com/r0bops/DeRPC/issues/3) |
| P2 | One complete verified read path | A fresh verified header anchors ETH and known-token storage proofs; corrupted answers are rejected | [#4](https://github.com/r0bops/DeRPC/issues/4), [#5](https://github.com/r0bops/DeRPC/issues/5), [#6](https://github.com/r0bops/DeRPC/issues/6) |
| P3 | A working RPC pool | At least two usable endpoints, local exclusion and bounded anonymous failover | [#7](https://github.com/r0bops/DeRPC/issues/7), [#8](https://github.com/r0bops/DeRPC/issues/8) |
| P4 | A usable provider and demo | A separate app consumes the provider; the UI explains verified reads and failures | [#9](https://github.com/r0bops/DeRPC/issues/9), [#10](https://github.com/r0bops/DeRPC/issues/10) |
| P5 | A reproducible submission | Failure checks pass, a clean checkout runs, docs and demo video are ready | [#11](https://github.com/r0bops/DeRPC/issues/11) |

Build a minimal page during P1 and grow it through these phases. Visual polish follows the working read and failover paths.

## P0 — Resolve the expensive unknowns first

Timebox: the first implementation hour. Investigations that need a running worker continue in P1; do not spend the day comparing libraries.

- [x] Compare Colibri and Lodestar on the actual requirements: browser execution, injected `worker.fetch` for every network request, locally checked consensus and state proofs, storage-proof support, and no hosted prover or checkpoint-service dependency. Treat old capability claims as unconfirmed. Choose a library only after a small integration experiment; record the version and limitations. **Done Nov 5:** Lodestar light client 1.43.0, tested in Node (browser run in P1). See CONTEXT.md §4 and §9.
- [x] Choose one anonymity worker and one execution chain. Prefer Tor or Nym for the existing hour-6 test; retain the other as a tested backup if practical. **Done:** tor-js, with Nym as backup; mainnet.
- [x] Account for the **specifier chain separately from the query chain**. The recorded Tor and Nym specifiers are on mainnet. Proving their hashes requires mainnet verification even when querying Sepolia. Prefer mainnet for the first demo if those workers are used; a Sepolia-only plan needs a compatible Sepolia specifier. Do not add a second light client merely to pursue ENS. **Done:** mainnet for both.
- [x] Record a full worker hash, local resolver list, checkpoint and chain configuration. Use the pin-then-verify bootstrap described below. Pinning is a trust decision; a truncated hash from the notes is not configuration. **Done:** full pin in CONTEXT.md §4; checkpoint is pinned at build time, with an initial 7-day maximum age.
- [x] Identify candidate public, keyless execution and consensus endpoints. Test proof availability at the chosen finalized block, anonymous reachability, response sizes and required browser behavior. **Done Nov 5:** through tor-js, 4 of 5 execution endpoints and both beacon endpoints work (CONTEXT.md §9).

**Output:** a short decision update in CONTEXT.md covering library, worker, execution/specifier chains, checkpoint policy and candidate endpoints. No dependency is declared working based solely on documentation.

## P1 — Prove that the private network path works

Deadline: no later than implementation hour 6, and always within the event deadline. The test must use a real Tor or Nym worker; passthrough and fixtures do not satisfy it.

- [x] Create the small TypeScript/Vite/pnpm project with a provider module separate from the demo. Add only the harness and dependencies needed for the experiment. **Done:** pnpm workspace with `provider/` (library) and `frontend/` (check page).
- [x] Supply a local bootstrap provider that answers both `workerHash()` and `workerResolvers()` for the expected specifier. Reject other bootstrap calls. Hash-check the downloaded worker bundle before execution through the harness. **Done:** `provider/src/transport/pinned-bootstrap.ts`. The harness hash-checked the bundle (the worker reached ready).
- [x] Start one long-lived worker, show boot progress, and bound requests with cancellation and timeouts. **Done:** booted in 6.6 s in headless Firefox; 60 s default timeout per call.
- [x] Fetch a real account/storage proof for a public test address through `worker.fetch`. Fetch the consensus data the selected light client needs through the same transport. **Done:** WETH account + slot proof (13.7 KB) and light-client bootstrap (53 KB) and optimistic update (2.4 KB), all through the worker.
- [x] Inspect browser traffic: no direct execution RPC, consensus or checkpoint requests. Document app assets, bundle loading and connections required to establish the anonymity transport separately; “no direct RPC” does not mean the browser makes no direct network connections. **Done:** page resource timing shows only page assets and the bundle download from cdn.jsdelivr.net. The WebRTC link to the Tor gateway is not visible in resource timing.
- [ ] Investigate the selected deployed worker's handling of isolation keys. Different observed exit IPs alone do not establish account unlinkability. Keep that claim out of the demo until there is evidence for the deployed implementation and its limits. **Observed once, not proven:** two keys used two different exits, consistently, over 4 requests (tor-js 0.4.4 documents per-key isolation). Keep the claim out of the demo until there is stronger evidence.

**Pass:** real proof bytes and required consensus data arrive anonymously, with no hidden direct fetches.

**If it fails:** try the backup worker or another endpoint within the timebox. Defer ENS and UI polish. If no viable route exists, record the failed gate and revise the scope explicitly; never substitute direct requests or call a mocked path private and verified.

## P2 — Verify one complete read path

Target: Thu night / Fri morning. This is the main technical deliverable.

- [x] Sync the light client from a pinned checkpoint. Define checkpoint age and verified-head freshness limits, reject stale state, and display the verified block and finality. Start with finalized reads; refuse unsupported block tags instead of silently changing their meaning. **Done Nov 5 (#4):** Lodestar 1.43.0 in headless Firefox through tor-js and our gateway: ready 4.2 s after the worker, every beacon request through the worker, the finalized header advances past the pin by polling. Limits: 7-day checkpoint, 30-min finalized header; ready only after a signature-verified head. #9419 backported with a regression test (it reproduced the attack on unpatched 1.43.0). 15 tests.
- [x] Derive balances and nonces from verified account proofs. Validate the requested address, storage key and block binding, including valid absence proofs. Never accept a root merely because an RPC supplied it or several RPCs agree. **Done Nov 5 (#5):** our own verifier (`provider/src/verify/`); requests name the verified block number; one isolation key per account; absence proofs handled.
- [x] Verify code against the proven code hash, and storage against the proven storage root. Demonstrate one ERC-20 balance using a known, documented storage layout; this is not generic token support. **Done (#5):** WETH (slot 3, not upgradeable). Live in Firefox through Tor: 2,082,568.11 ETH (WETH contract) and 4,276.84 WETH (Uniswap V2 USDC/WETH pair) at the verified block; WETH code checked against its proven hash.
- [x] After the worker starts, prove the specifier's worker-hash slot against the appropriate chain's verified state and compare it with the local pin. Keep user reads unavailable until this passes. A mismatch or inability to verify stops initialization. This establishes agreement at the verified block, not instantaneous knowledge of every owner update. **Done Nov 5 (#6):** `provider/src/verify/worker-pin.ts`. Reads go through a gate that holds them until the check passes and refuses them forever if it fails. Live in Firefox: verified at block 26350150; with an injected wrong pin, all reads were refused. Pin update procedure: ANON_RPC.md.
- [x] Return block number from verified header state. **Done:** `eth_blockNumber` reads the authenticated finalized header. Generic `eth_call` stays disabled by default; #48 adds an explicit local verified execution option. Logs, writes and unsupported methods are refused.
- [x] Add focused checks for tampered values/proofs, wrong account/slot/block, missing accounts, stale checkpoints/headers, a bad worker bundle hash and a specifier pin mismatch. **Mostly done (#4, #5):** tampered values and proofs, wrong account/slot/block, missing accounts, truncated and padded proofs, stale checkpoint/header, forged sync-committee signature, wrong chain, Lodestar #9419. Bad worker bundle hash and specifier pin mismatch added with #6 (unit tests and live in Firefox).

**Pass:** a live verified ETH balance and known-token storage read succeed; corrupted or stale data cannot become a successful verified result. The verifier runs in the host.

## P3 — Turn verified reads into a pool

Target: the core three-step demo works by midday Fri Nov 6, IST.

- [x] Use a small curated set of 2–3 public endpoints for the selected chain, with at least two confirmed usable through the worker. Record operators where known; multiple URLs do not prove independent ownership. **Done Nov 5 (#7, #15):** `MAINNET_OPERATORS`: dRPC, MEV Blocker and BlockRazor preferred; Blast and PublicNode as fallback. All five served proofs through Tor. Each operator carries a mock ENS name (`<operator>.derpc.eth`) until real subnames exist.
- [x] Select an eligible endpoint randomly. Keep one request in flight per read by default; racing is deferred because it exposes the query to more providers and adds traffic. **Done:** random within the best eligible tier; one attempt at a time.
  - **Changed Nov 5 (team direction): the user chooses the operators.** Nothing is preselected, and with no choice there are no reads (`NoOperatorsChosenError`), including the worker-pin check. The pool holds only the chosen operators. Each account stays with the operator that first served it, and moves to another chosen operator only when that one fails. The random pick now applies only to an account's first read, among the user's preferred-tier choices. The choice is saved on the device.
  - **Updated Nov 6:** this remains the manual mode. The team also authorized explicit automatic balanced/fastest/reliable modes over eligible free candidates, with optional allowlist restrictions. No first-visit implicit opt-in, query racing, direct fallback or unproven ENS expansion is introduced.
- [x] Exclude endpoints returning invalid proofs locally. Apply temporary cooldowns to timeouts or rate limits. Do not present either event as publicly attributable misconduct: an untrusted worker can also alter a response. **Done:** an invalid proof excludes the endpoint locally for the session; timeouts, rate limits, RPC errors (including the proof-window error) and Tor exit failures give a 60 s cooldown.
- [x] Retry with another eligible endpoint through the worker, using the same verified block where available. Bound attempts and total time; all endpoints exhausted returns an explicit error. **Done (#7, #14):** each retry uses another endpoint and a fresh Tor circuit (a key derived from the same account's key); at most 3 attempts and 30 s; `PoolExhaustedError` lists every attempt. Stale-header, worker-pin and dead-transport errors are never retried.
- [x] Keep routing and exclusion state on the device. Isolate caches and endpoint state by chain; cache verified values by block identity and requested account/key. **Done:** state is in memory on the device; verified results are cached by verified block hash and request.
- [x] Test invalid-proof failover, timeout failover, total pool exhaustion, worker crash and anonymous-network loss. Network loss must produce an error with zero direct RPC fallback. **Done (#8):** unit tests for each case; live in Firefox through Tor: the simulated lying node was rejected and excluded, and the same balance came from BlockRazor; after cutting the network, every read failed with `TransportUnavailableError` and nothing went direct.

**Pass:** normal read → deliberately corrupted response rejected and endpoint excluded → another endpoint succeeds; disabling anonymous connectivity makes further reads fail closed.

The corrupt-response fixture demonstrates client rejection, not an accusation against a real public provider. Keep it clearly labeled and separate from the live successful path.

## P4 — Make the pool useful to integrators and visible in the demo

Target: Fri afternoon. Preserve a minimal working screen throughout earlier phases.

- [x] Expose the read provider through an EIP-1193-style request interface and a viem integration. Document its supported methods, block semantics, cancellation, initialization and errors; it is not a complete wallet RPC replacement. **Done Nov 5 (#9):** `createDeRPC` returns an EIP-1193 provider, a reader with proof context, `setOperators`, `status` and `close`; `@derpc/provider/viem` gives `derpcTransport` (viem retries off). Proven: balance, nonce, code, storage, plus the verified block number; everything else is refused with 4200 before anything is sent. Only the verified finalized block is accepted (`"latest"` gets -32602). Documented in `provider/README.md`. 118 tests.
- [x] Have the demo consume that public interface rather than bypassing the provider. Export a DeRPC configuration/integration example, not a plain endpoint URL that loses the guarantees. **Done (#9, #10):** the demo uses only `createDeRPC` and viem; `frontend/example.html` is a 40-line integrator example (one proven read, one refused `eth_call`). The low-level P1 diagnostics moved to `frontend/network-check.html`.
  - **Nov 6 integration:** the directory's API preview also uses `blockTag: "finalized"`. `pnpm build:site` packages the directory and demo into `web/dist/`, linked at `/demo/`; release builds require a public gateway in the shell. Validate the actual public deployment separately from the local build.
- [x] Show worker boot and verifier sync progress, checkpoint/finality, pool availability, selected endpoint, proof status, local exclusion and failover. **Done (#10):** start-up table (worker, light client with checkpoint age, verified block, worker pin), the operator chooser, a "via" column per read, and live operator states and events.
- [x] Provide controls for the labeled corrupt-response scenario and network shutdown. Show measured timings as this client's experience, not global uptime or a universal score. **Done (#10):** "Inject a lying operator (simulated)" (`simulatedLyingOperator`) and "Cut the anonymous network" (`derpc.close()`); timings are per read on this page.
- [x] Keep any probes bounded and use public fixtures rather than sending a user's addresses to every endpoint. Add no analytics or query collection service. **Done:** the demo reads public contracts only, through the chosen operators; the network check probes every endpoint with a public fixture only when its button is pressed.
- Found while testing P4 live: with two chosen operators, one Tor exit failure each left nothing to try for 60 s. **Fixed:** when no fresh operator is left, the pool gives a resting (not excluded) one another try on a fresh circuit, and a success ends its cooldown (#14).

**Pass:** another small browser consumer can use the provider from its documented example, and a viewer can follow all three demo steps without reading the code.

## P5 — Finish the submission

Target: core feature freeze Fri evening; aim to have the submission ready by Sat Nov 7, 07:30 IST. The deadline recorded in SUBMISSION.md is **09:00 IST**. If implementation starts late, drop stretch work rather than moving these deadlines.

- [ ] Run the focused verification and failure checks plus the live browser flow. Confirm the network trace still has no direct RPC fallback. Do not wait until this phase to write the P2/P3 checks.
- [x] Write THREAT_MODEL.md: checkpoint and worker-pin trust, query-content visibility, isolation limitations, curated discovery, availability, finality and method support. **Done:** [threat model](../THREAT_MODEL.md) and [architecture reference](../ARCHITECTURE.md); public release evidence remains separately gated.
- [x] Write README run instructions, provider example, supported network/method list, CROPS section and a table of traffic that bypasses the worker. Explain the client-side pool and the limits of the decentralization claim. **Done:** current [README](../README.md), provider guide and offline assembled-site checker; Node 24, bundle acquisition and separate payment traffic are disclosed.
- [ ] Record a 2–3 minute demo with human narration, at least 720p. Capture a backup as soon as the core flow works. Team members own recording, submission and partner conversations.
- [x] Prepare EF integration feedback and submission text. **Done:** [partner feedback](../FEEDBACK.md) and [submission packet](SUBMISSION_DRAFT.md), including a reviewed 2:45 human-narration script. Recording, upload and submission remain team steps. ENS is selected only if the actual integration ships.
- [x] Make small, frequent commits, each one logical change with a `scope: description` message; the hackathon rules disqualify large single commits. **Done Nov 6:** the implementation changes are recorded in dependency-ordered local commits; nothing was pushed.
- [ ] Preserve prompts/specs and keep the planning, repository and prompt sections of AI_USAGE.md accurate. Add attribution for other areas when the team directs, and finalize required disclosure before submission.
- [x] Review the raw Grok planning transcript before making it public, as CONTEXT.md requests; do not edit or remove the verbatim archive as part of this roadmap task. **Reviewed Nov 6:** private conversation/canvas links and work/project context require the team's publication decision; no credential-like material was found. The transcript was preserved unchanged. See [the release review](QA_REPORT.md#publication-review).

**Pass:** a clean checkout runs from the README, the demonstrated guarantees match the implementation, and submission materials are ready before the deadline.

## ENS operator registry

Tracked in [issue #12](https://github.com/r0bops/DeRPC/issues/12).

The core demo passed and the team explicitly included this work on Nov 6. Preserve the deployment and evidence gates below.

**Plan (Nov 6): mainnet, ENSv2, under `derpc.eth`.** The name is registered in the ENSv2 registry on mainnet (checked on-chain Nov 6: it has an owner and a resolver, and no subregistry yet). ENSv2 is in use on mainnet, and mainnet is the chain the light client follows, so this needs no additional chain verifier. The earlier Sepolia idea is dropped: Lodestar 1.43.0 can't follow Sepolia, so nothing there could be proven. Not tested yet: deploying a subregistry through the factory and registering a subname end to end.

| Order | Step | What can be claimed after it | Issue |
|---|---|---|---|
| 1 | Deploy the operator subregistry under `derpc.eth` and register 2–3 operator subnames, non-transferable, with a short expiry | Operators have real names | [#44](https://github.com/r0bops/DeRPC/issues/44) |
| 2 | One resolver per operator, with `derpc.endpoint`, `derpc.signer` and `derpc.caps` text records | Endpoints are published on-chain | [#45](https://github.com/r0bops/DeRPC/issues/45) |
| 3 | The client reads the list and records through Anon-RPC and feeds the pool from them | Operators come from ENS, read privately, labeled **unverified discovery**; RPC answers are still proven | [#46](https://github.com/r0bops/DeRPC/issues/46) |
| 4 | A registrar contract in front of the subregistry that keeps the operator array in our own storage layout | The operator list is proven with storage proofs; the records are not | [#47](https://github.com/r0bops/DeRPC/issues/47) |
| 5 | Verified `eth_call`: run bounded mainnet calls locally against proven state (implemented Nov 6) | Supported on-chain records can be proven within execution limits; unsupported context and off-chain resolution are refused | [#48](https://github.com/r0bops/DeRPC/issues/48) |
| 6 | Onion endpoints in the endpoint record (implemented and tested Nov 6) | The client knows it reached the key holder, with no exit relay involved | [#49](https://github.com/r0bops/DeRPC/issues/49) |

Rules that stay in force:

- Any unverified discovery path stays labeled and separate. Generic `eth_call` is disabled by default; explicit local execution proves every account/code/storage dependency against one authenticated mainnet block. Neither mode weakens ordinary read verification.
- A registry's claim that an endpoint supports proofs is tested locally.
- The list is curated while the owner of `derpc.eth` can repoint the subregistry, even though it is on-chain. Say so.
- The current curated registrar is free. The team's later operator/node staking design is separate: distinguish refundable deposits, fees and any slashable collateral explicitly. No amount or penalty is chosen for the free release.
- ENSv2 resolver roles have no per-name scoping, so each operator gets its own resolver. Names resolved through an off-chain gateway are rejected.
- Resolving a name still shows the operator which name is read. Don't claim otherwise.

## Plan: operator wrapper and per-query payments

Direction from the team (Nov 6). Implementation and evidence are summarized in the status table above; public deployment gates remain open. It follows three research syntheses (ENS, wrapper, payments) whose disputed facts were checked against primary sources; claims taken from the reports alone stay marked as unchecked.

### Operator wrapper

Software an operator runs in front of its node: a Tor onion service that forwards to a small proxy, which passes only what DeRPC needs. The onion address is a public key, so it is the endpoint's identity, and no exit relay is involved.

| Order | Step | Issue |
|---|---|---|
| 1 | The wrapper: onion service, body-aware allowlist (`eth_getProof`, `eth_getCode`, `eth_chainId`), batch checks, caps, proof cache | [#50](https://github.com/r0bops/DeRPC/issues/50) |
| 2 | The client reads through an onion endpoint (real Firefox/tor-js path passed Nov 6) | [#49](https://github.com/r0bops/DeRPC/issues/49) |
| 3 | The four beacon light-client routes, so one operator serves everything a client needs | [#51](https://github.com/r0bops/DeRPC/issues/51) |
| 4 | Identity document, and the client's check that name and endpoint point at each other | [#52](https://github.com/r0bops/DeRPC/issues/52) |
| 5 | Setup command with a self-test (a proof at the finalized block) that prints the ENS records | [#53](https://github.com/r0bops/DeRPC/issues/53) |
| 6 | Personal mode: a second, unpublished onion service for the node's owner | [#54](https://github.com/r0bops/DeRPC/issues/54) |
| 7 | Never pair a gateway and an RPC service run by one operator | [#55](https://github.com/r0bops/DeRPC/issues/55) |

Checked on Nov 6:

- tor-js reaches onion services since 0.4.2, client side only, and doesn't enable onion client authorization (its changelog). Its build turns on only the onion-client feature, so Tor's proof-of-work defence stays off in the wrapper.
- DeRPC sends only `eth_getProof` and `eth_getCode`, and its light client uses four beacon routes.
- Reth's default window for historical proofs is 0 blocks, so the setup command must test a proof at the finalized block.
- An operator needs a full node (about 2 TB of fast disk by 2026 hosting guides, which are estimates), not an archive node. A light client can't be an operator, and a proxy in front of someone else's node adds no independence.

Rules:

- The wrapper is never trusted, and nothing in it weakens client-side verification.
- It never claims: no query logs, runs its own node, guaranteed uptime, unmodified software, or that it can't link users to requests. A client can't check these.
- The name-to-endpoint check is only as strong as the ENS read. It becomes a real guarantee with a proven list and proven records ([#47](https://github.com/r0bops/DeRPC/issues/47), [#48](https://github.com/r0bops/DeRPC/issues/48)).
- Demo operators that proxy a public endpoint are labeled as proxies. The local demo runs the gateway and proxy under the same tester, which provides no separation; its evidence explicitly discloses this.
- Written from scratch: no Dshackle fork (CONTEXT.md §8).

### Per-query payments

**Decided Nov 6: payments don't need to be private.** The payer may be known to the operator and visible on-chain; no private-funding step is planned. The operator still doesn't see the payer's IP. The README must say that paid queries are linkable to the paying account.

The mechanism: a prepaid deposit in a neutral contract, signed vouchers for a running total, and one settlement. The client signs a voucher only after the proof verifies, so a wrong answer is never paid.

| Order | Step | Issue |
|---|---|---|
| 1 | Escrow contract: `open`, `close`, `refund`, vouchers bound to chain, contract and session; test funds on a testnet | [#56](https://github.com/r0bops/DeRPC/issues/56) |
| 2 | The client signs a voucher after each verified read, with a small credit window and a session per chosen operator | [#57](https://github.com/r0bops/DeRPC/issues/57) |
| 3 | The wrapper checks vouchers, stops serving past the credit window, and settles before the refund timeout | [#58](https://github.com/r0bops/DeRPC/issues/58) |
| 4 | Price and payee in the operator's ENS records | [#59](https://github.com/r0bops/DeRPC/issues/59) |
| 5 | Payment panel in the demo: counter, the lying operator isn't paid, one closing transaction | [#60](https://github.com/r0bops/DeRPC/issues/60) |
| 6 | Apps paying for their users, and agents with spending limits | [#61](https://github.com/r0bops/DeRPC/issues/61) |
| 7 | Settlement chain for real funds, a provable payee, and a legal review first | [#62](https://github.com/r0bops/DeRPC/issues/62) |

Rules:

- The chain an operator serves and the chain it's paid on are independent. Reads stay on mainnet; a demo pays on a testnet.
- Test payments show the mechanism. They don't show that the incentive works, and the demo says "test payments".
- The registrar payee is proven from storage; resolver payment records have their own explicit provenance. A proven payee does not prove the payment-chain deployment: the client separately pins its chain, escrow runtime and terms. Public manifests and records are still needed before the testnet demo.
- A deposit transaction sent by the user's wallet goes outside the worker and is declared in the README's traffic table.
- The research reports price a single proof read at a few thousandths of a cent (unchecked). At that price payment works first as a limit on abuse by anonymous callers, not as operator income. Don't claim income until measured volume supports it.
- Staking and slashing are not part of this plan (order 7 below).

Implemented design: a distinct funded session per paid operator, a wrapper settlement safety margin before refund, and capped/revocable app delegations with reservations persisted before signing. An app must supply a trusted evidence verifier; arbitrary caller-provided proof claims are insufficient.

## After the hackathon

| Order | Focus | Evidence required before calling it supported |
|---|---|---|
| 1 | Wallet/app adoption | One real external integration; measured startup, memory, latency and method requirements; review the existing Kohaku integration path |
| 2 | Server-side agents | A suitable isolated runtime carrying real anonymous traffic, with the same verification and failure checks; a typed read-only agent adapter without wallet keys |
| 3 | Additional EVM chains | For each chain: authenticated headers/state roots, supported proof format, finality/freshness policy and working anonymous endpoints; chain-family adapters may share code |
| 4 | Distributed discovery | A replaceable registry/list source with documented curator permissions and revocation; permissionless registration needs a Sybil-resistance design |
| 5 | Local selection improvements | Measured success/latency, bounded exploration and traffic concentration; published probes remain hints, never an authoritative ranking |
| 6 | Signed accountability | Responses bound to operator, chain, request and block; independently verifiable evidence and dispute rules before considering penalties |
| 7 | Operator economics after the free release | Requested identity stake, traffic-dependent per-node stake and operator-set query prices; economic rules, withdrawal and multi-node accounting remain open; no token requirement |
| 8 | Richer verified reads and query-content privacy | Broader execution beyond the bounded mainnet implementation; separate research for PIR and private proof retrieval |

Orders 2 and 3 can change based on the first integrator's needs. Neither is a prerequisite for the hackathon. Anon-RPC transport compatibility does not establish chain verification support, and a browser demo does not establish a production agent runtime.

## To do: user-chosen operators from an ENS list

Direction from the team (Nov 5). The user's choice is built now with mock ENS names; real subnames come in a later milestone.

- [ ] Operators register a subname of the main domain (for example `alice.derpc.eth`) as their service identity. A name does not prove service quality or honesty. The later requested flow adds identity/node staking; the current registrar is curated and free.
- [x] DeRPC shows the list, and users choose their operators manually or explicitly authorize an automatic policy. **Manual mode built Nov 5 with mock names:** `MAINNET_OPERATORS` gives each operator a placeholder `<operator>.derpc.eth` name (`ENS_NAMES_ARE_MOCK`), and the demo marks them "mock". Live in Firefox through Tor: no reads before a choice; with MEV Blocker and BlockRazor chosen, the pin check and every read used only those two; the choice survived a reload. The Nov 6 automatic-mode direction adds all-eligible or restricted selection without changing this legacy default.
- [ ] Replace the mock names with real subnames read through the worker (#44, #45, #46), and prove the list (#47) and the records (#48).
- [ ] Decide who can mint a subname, what a subname must carry (endpoint, chain, proof support), and how it can be revoked or expire. **Proposed Nov 6:** a registrar contract registers and renews names (#47); records are `derpc.endpoint`, `derpc.signer` and `derpc.caps` (#45); a name that isn't renewed expires and drops out.
- [x] Decide what happens when a chosen operator fails or returns an invalid proof. **Current behavior:** retry only among the operators the user picked; if all of them fail, the read fails with `PoolExhaustedError` and the user can choose more. Revisit with the team if they'd rather stop and ask.

This builds on the gated ENS stretch (#12): the user's explicit selection or automatic policy defines the permitted pool. Local measurements can rank candidates only within that authorization; they do not authorize new chains, paid sessions or unproven ENS records.

## Scope cuts when time is tight

The earlier scheduling advice was to cut ENS first, then extra providers and optional UI detail. The team subsequently included all #44–62; do not silently remove those requirements. Keep the fresh verified header, supported-read proofs, pinned bootstrap, anonymous transport and failure tests. If a required gate cannot be met, report the incomplete feature explicitly rather than weakening its meaning.

Do not add a full explorer, global rankings, a central proxy, slashing or extra prize integrations to rescue a blocked core. The requested staking design is recorded but activation follows the free release, alongside the deferred payment rollout. General wallet transaction RPC remains outside the verified-read provider.
