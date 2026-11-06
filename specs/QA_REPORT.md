# Project QA — November 6, 2026

This report records dated QA snapshots. The latest branch integration below passed the combined automated suite and a fresh public-gateway verified-read/shutdown check. Earlier failures and their narrower historical conclusions remain recorded in their own sections. Payments remain off and independent-operator ENS onboarding remains deferred, as specified in [CONTEXT.md](CONTEXT.md).

The initial review covers the working tree based on `cccee83`, including the pending provider, frontend, contracts, payments, wrapper and website changes. A SHA-256 inventory of 253 source/document files was unchanged between the start and end of that review, before adding this report. Node 24.16.0 and pnpm 11.22.0 were used. That review left implementation files unchanged; the subsequently authorized fixes are recorded separately below. Neither exercise constitutes an independent security audit.

## Committee-boundary cold start (#27) — November 6, 19:54 UTC

The [fresh Firefox 156.0.1 live check](../provider/test/light-client/period-1904-evidence-2026-11-06.json) passed from **19:54:11 to 19:54:34 UTC**, after period 1904 began at 19:53:59. The original checkpoint remained epoch `487173`, root `0x35bd26d77ecef24031f37b86d4be488fd66c472eb68c11595ca1f327a9a54f24`. A new browser profile, isolated Vite cache and new light client started with only committee 1903 installed; forced updates remained disabled.

The production verifier accepted a period-1903 update signed by **511 of 512 members** with finality and next-committee proofs. It then installed that exact authenticated committee and accepted a period-1904 update signed by **510 members**, at signature slot **15597570**, advancing its head to slot **15597569**. Evidence is tied to the active returned light client, not a discarded startup attempt or merely downloaded response. Worker-pin verification and a WETH-contract ETH balance proof succeeded at finalized mainnet block **26357966**. The finalized header was still in period 1903 (slot 15597504), as expected immediately after the boundary; the accepted signature/head were in 1904.

There were zero external browser HTTP requests, zero blocked direct-request attempts, zero page errors and zero new anonymous calls during the one-second post-close observation. Closing removed the worker iframe and the next read raised `TransportUnavailableError`. Source/harness/installed-patch hashes were unchanged. No checkpoint refresh, synthetic clock, preload, timeout relaxation or verifier bypass was used. This clears #27's live cold-start requirement through the existing local gateway; it does not clear public hosting or future checkpoint-expiry requirements.

The manual runner is `provider/test/light-client/period-cold-start.mjs`, with `DERPC_TEST_GATEWAY` set to a working KPS address and `--live --report <path>`; `--live` refuses to start before the real boundary. The `--preflight` mode never marks that gate passed. The first preparation attempt exposed a test-page Buffer import-order error, corrected in the harness; final preflight passed at 19:23 UTC and was not counted as boundary evidence. Expanded security/lifecycle regressions passed **39 tests across six files**, including genuine signed-update/exact-committee verification, corrupt signatures, corrupt finality and missing-finality refusal. Production code did not need another change.

## Branch integration review — November 6, 19:27 UTC

The requested read-only branch review compared GitHub main `9f3026ed21fcd33928c52113465bb005927bc01d` with all four other remote branches. Local main advanced to `e17bcf79521967ed3d4087ac941067a22a8244b3` during the review; the affected source hashes were checked again and remained unchanged. Commit ancestry alone is insufficient: several branch changes landed through separate implementations, while the following fixes remain absent.

| Branch / PR | Required disposition |
| --- | --- |
| `provider-fixes` / [#42](https://github.com/r0bops/DeRPC/pull/42) | Conflicts with main. Retain the specific missing fixes below in focused changes; do not overwrite the newer provider/ENS/payment lifecycle implementation with the old branch. |
| `gateway-check` / [#43](https://github.com/r0bops/DeRPC/pull/43) | Superseded by main's release guards (`602838a`) and stricter gateway/certificate validation (`1a6164a`). No missing gateway functionality found; closure is appropriate after tracker review. |
| `threat-model` / [#63](https://github.com/r0bops/DeRPC/pull/63) | The PR targets `provider-fixes`, not main. Its older read-only threat model and timeout description are superseded by the expanded local documentation (`96ab6d2`); confirm that documentation is published before closing it. |
| `web-directory` | Main has the newer directory/onboarding implementation and identical brand assets. Retain the example typing and favicon-path corrections below, then retire the old branch. No open PR was found. |
| `issue-review-fixes` / [#64](https://github.com/r0bops/DeRPC/pull/64) | Newly published during this review. Useful unique portability, benchmark and documentation changes; correct local-port detection and qualify the bundle-size statement before merging. |
| `front-presentation` | Newly published during this review, without a PR. Hold the traffic panel: it overclaims coverage and bypasses the robust timing collector. Review the stalled-start explanation separately. |

Missing changes reproduced against the current source:

1. **Verified-cache mutation (#38):** `provider/src/pool/pooled-reader.ts` stores and returns the same result object. With a real recorded proof, changing the first result changed the second cached result from balance `0` at block `26350087` to balance `1` at block `42`, without another proof request. This requires host-app access; it is not a remote proof forgery. Port the isolation intent of `a0e7f645`, including the newer nested `block.execution` metadata.
2. **Network-outage attribution (#35):** a `NetworkUnavailableError` becomes a failed operator observation/cooldown and `PoolExhaustedError`; direct EIP-1193 mapping gives `-32603`. Retain the network-specific classification, status and error intent of `646ef077`, together with the branch's transport timeout/cancellation distinction, while preserving newer routing and payment behavior.
3. **Contradictory block selectors (#39):** an object containing a valid finalized `blockHash` and conflicting `blockNumber: "0x1"` is accepted. Port `195b9863`'s input rejection and regression without replacing the newer local-execution API.
4. **Website example typing:** `web/src/ui.ts` passes readonly `MAINNET_OPERATORS` to mutable `DeRPCOptions.operators`; an isolated TypeScript check reports `TS4104`. Retain `7ca3f883`'s explicit selection/copy, or separately review readonly-array support in the public API.
5. **Favicon documentation:** `docs/design-system.md` names nonexistent `brand/derpc-favicon.svg`; `f0f5aba4` correctly points to `web/public/favicon.svg`.

Issues #35, #38 and #39 are closed on GitHub, but their described failures are reproducible on this main snapshot. Earlier status summaries that relied on the tracker do not establish their fixes are present. Secondary branch changes for startup-error normalization and asynchronous validation rejection still need separate review. No branch was merged, no issue was reopened, and this review did not change production code. Runnable reproductions, TypeScript output, source hashes and GitHub snapshots are retained locally in `/tmp/derpc-branch-review-20261106/`.

**Final branch inventory, 19:59 UTC:** GitHub had seven branches including main and four open PRs (#42, #43, #63, #64). Remote main was still `9f3026ed`. The two new branch findings below concern those branch snapshots, not the current main code validated for #19 and #27.

- **PR #64, `16f4ca38`:** its five-file patch applies cleanly and is not duplicated in main. However, `lsof -iUDP:12298` matches either endpoint of a UDP connection. A real owned socket bound to local port 60090 and connected to remote loopback port 12298 made the check succeed, without sending a datagram; that client is not a locally bound gateway. Check the local port and add that negative case. Six mocked helper tests passed in an isolated temporary copy after allowing subprocess execution; they do not cover this false positive or establish an actual macOS run. Bash and benchmark syntax checks passed. The new Chrome evidence's source hash matches current `verified-call.ts`, and its five-sample 45.1 ms median is scoped to generated proofs without Tor/network latency. Its 98,606 gzip bytes describe the isolated benchmark output, including fixture/bootstrap code, not a measured incremental production-page cost. Prefer that wording and describe raw calldata as not forwarded, without implying the operator cannot infer the call from access patterns. Evidence is in `/tmp/derpc-pr64-review/`.
- **`front-presentation`, `ee500fb9`:** isolated evaluation of the branch's exact `renderTraffic()` function reports `100% through Anon-RPC` and `0 direct` both when timings are empty and when they include a direct request to a custom operator absent from the built-in host list. Missing `performance.getEntriesByType` throws. Its numerator counts fetch attempts before dispatch; its denominator mixes those attempts with incomplete ResourceTiming observations. Replace the percentage with explicitly scoped attempted/observed counts, use the existing bounded collector and missing-API handling, and cover custom/ENS endpoints and cleared buffers. This branch would otherwise undo #19's honest uncertainty behavior. Reproduction and results are `/tmp/derpc-front-presentation-review.mjs` and `.json`.

### Suggested remaining commit split for this continuation

The committee-authenticity regressions and manual cold-start harness already appear in local commits `d4d3ccd`, `54a578b` and `e17bcf7`, created by the separate committer. Do not duplicate those changes. The remaining working-tree additions split as follows:

1. `frontend: verify diagnostics in Firefox private windows` — `frontend/test/direct-connections-firefox.mjs` and `frontend/test/direct-connections-firefox-evidence-2026-11-06.json`.
2. `test: record successful period-1904 cold start` — `provider/test/light-client/period-1904-evidence-2026-11-06.json`.
3. `docs: record completed checks and branch integration gaps` — `README.md`, `THREAT_MODEL.md`, `AI_USAGE.md`, `REPO_LAYOUT.md`, and the matching updates to `specs/CONTEXT.md`, `specs/ROADMAP.md`, `specs/OPERATIONS.md`, `specs/QA_REPORT.md` and `specs/SUBMISSION_DRAFT.md`.

At the time of this earlier read-only continuation, no staging, commits, push, merge, deployment or issue/PR updates occurred. Its integration recommendations were subsequently implemented and validated in the later branch integration section below.

## Reviewed branch integration — November 6, 21:52 UTC

The six divergent branch heads were reviewed against main `c183ecd86a9f906fcf0983c518d6441e98ad851b` in an isolated checkout. Useful changes were reconciled in scoped commits before recording the branch ancestry; older implementations already superseded by main were retained as history, not restored over the current code. The shared checkout's separate deployment changes were not included. Before the final integration, main advanced to `ec37572c` by merging PR #64 at `0149c90a`; that merge was incorporated, preserving its gateway implementation and additional mixed-socket regression.

| Branch | Resolution |
| --- | --- |
| `provider-fixes` (`27ee186e`) | Port cache isolation, network failure attribution, EIP-1898 selector validation, readonly inputs and asynchronous validation; retain newer ENS, multi-endpoint, routing and payment guards. |
| `gateway-check` (`ffacc2e7`) | Retain the existing main release checks, which include stronger certificate and fallback validation. |
| `threat-model` (`bce3557b`) | Retain the broader current threat model and implemented local EVM scope; update committee evidence instead of restoring older claims. |
| `web-directory` (`f0f5aba4`) | Retain the current site; correct the selected-operator example, favicon path and multi-endpoint capability wording. |
| `issue-review-fixes` (`0149c90a`, merged as #64) | Port portable gateway detection with local-port negative cases, and qualify benchmark, call-access-pattern and payee claims. |
| `front-presentation` (`ee500fb9`) | Port slow-start diagnostics and attempted-request counts. Keep bounded ResourceTiming observations separate; never calculate an anonymity percentage from incompatible/incomplete counts. |

Validation of the combined implementation:

- **1,050 default tests passed:** provider 602, frontend 257, contracts 65, payments 68, wrapper 58. The later main reconciliation added its mixed-socket regression; the focused gateway suite was rerun on the combined 13 cases. Five opt-in ENS fork tests remain skipped in this default run. The final syntax-only compatibility change additionally passed 48 provider regressions. Initial restricted runs that could not spawn child processes or bind loopback ports were rerun with that access; they were environment failures, not hidden product failures.
- All five package typechecks passed. The web and frontend production builds and assembled-site offline checks passed. Existing bundle-size warnings remain; building an artifact does not publish it.
- [Six integrated Firefox cases](../frontend/test/direct-connections-firefox-integration-evidence-2026-11-06.json) passed on the actual main and network-check pages: normal/private warm caches, cleared timing buffers and unavailable timing APIs. An independent HTTP observer confirmed cached responses and one fixture-server hit. The UI transport is deliberately stubbed, so this is diagnostic behavior evidence, not a Tor claim. [The earlier #19 evidence](../frontend/test/direct-connections-firefox-evidence-2026-11-06.json) is preserved with its historical source hashes.
- [Fresh integrated live Firefox evidence](../provider/test/light-client/period-1904-integration-evidence-2026-11-06.json) passed through the existing public gateway at 21:51 UTC: period-1904 committee verification, worker pin and balance proof at finalized block **26358539**, no direct RPC/beacon requests, no page errors, no calls after close and no remaining worker iframe. All 38 recorded source/runtime hashes were unchanged. The original checkpoint and production timeouts were preserved; forced updates remained disabled. [The original 19:54 cold start](../provider/test/light-client/period-1904-evidence-2026-11-06.json) remains separately recorded.

The integration review also caught and fixed failed-circuit reuse across logical reads, terminal startup errors swallowed by the upstream client, loss of total-budget diagnostics, and a TypeScript syntax compatibility issue in transitive payment imports. Network failures renew isolation keys without cooldown or ranking penalties; cached result/header mutations cannot change future verified answers. Payment completion remains terminal and no direct fallback was added.

The CI workflow checks and packages pushes/PRs. Site publication remains a manual workflow, and ENS transactions are separate. This branch integration does not deploy a site, activate payments, establish independent operator enrollment or complete an external security review.

## Local release completion — November 6, 16:12 UTC

The team's request to finish locally actionable work produced gateway-first worker acquisition, corrected browser traffic diagnostics, offline release checks and submission materials. These changes ran alongside the separate ENS/multiple-endpoint implementation; the checks below cover their combined working tree. They do not clear public infrastructure, independent operator or wallet-signature gates.

| Check | Result |
| --- | --- |
| Default workspace suite | **1,004 tests passed** in the parallel agent's final 16:13 UTC run; five opt-in ENS fork tests skipped. The earlier 16:06 integration run passed 1,003 before the additional provider regression. |
| Final package counts | Contracts: 65; payments: 68; provider: 576; wrapper: 58; frontend: 237. Affected contract/provider suites also passed in focused follow-up checks. |
| Type checking | Workspace passed; provider rerun passed after its final routing review change. |
| Combined static build | `pnpm build:site` passed; rebuilt after the final provider change. Existing bundle-size and Node-externalization warnings remain. |
| Offline release check | `scripts/check-release.mjs --json` passed on the resulting 46-file `web/dist/`. Only the explicitly supplied upstream demonstration gateway was used; its availability remains unverified. |
| Release checker negative cases | Twelve tests cover missing/mismatched inputs/assets, checkpoint expiry, initial payment controls and known accidental local-file/address patterns. |
| Payment review | Both earlier lifecycle defects remain fixed with regressions; focused payment/wrapper checks found no new material issue. |
| Documentation | Local link targets and Node 24 metadata checked; architecture and recording steps reviewed against the actual controls. |

A source/config hash inventory tracked concurrent edits. Receipt/lifecycle verification, provider routing and the optional fork test changed after the first run; the final default suite includes the updated implementation, while fork execution remains separate. The separate M1-B live runner was still being adjusted by its owning agent after these checks; no sibling-onion success is claimed by this release report. Application source remained unchanged. This is a working-tree validation, not a new committed release. Logs, a retained copy of the parallel final suite and the final offline report are in `/tmp/derpc-release-completion-gMnMF5/` on the test machine.

### Worker delivery (#16)

The local bootstrap now prepends selected-gateway mirrors only for the advertised exact worker-hash KPS path, deduplicates them and retains the recorded bundle fallbacks. It preserves the hash, raw pin and unsupported-worker behavior. Independent ABI decoding and refusal tests cover the change.

[Fresh Firefox evidence](../provider/test/transport/kps-bootstrap-live-2026-11-06.json) records acceptance of the real pinned bundle in 2.112 seconds, worker readiness in 5.755 seconds, zero external HTTP/CDN requests, iframe removal on close and refusal of a later fetch. The first attempt used an old LAN address and correctly fell back to the declared CDN but failed to become ready. A temporary current-interface override passed; no environment file or existing service was changed. This is local gateway/bundle evidence, with no execution/consensus query or public-deployment claim. The upstream harness's missing bundle-body deadline/abort remains explicitly recorded.

### Browser timing panel (#19)

Both the main demo and network-check page use one bounded observer/snapshot collector. It retains up to 512 exposed observations, deduplicates buffered callbacks, keeps earlier observations when browser timing buffers clear, and stops/resumes with page lifecycle events. Missing timing APIs and empty buffers produce visible uncertainty rather than an empty success-looking table. Counts describe exposed resource loads; cached loads need not transfer bytes. WebRTC, separate execution contexts and wallet traffic are outside its coverage.

[Chromium UI evidence](../frontend/test/direct-connections-browser-evidence-2026-11-06.json) covers both pages in normal/private contexts with warm cache and unavailable timing APIs: cached resource timings remained visible, buffer clearing retained prior observations, and unavailable APIs produced warning states without JavaScript errors. The transport was replaced in memory with a failing UI stub for this check; it is not live Tor or public gateway evidence. The production code still uses the real transport.

**Firefox requirement completed at 19:28 UTC:** [six Firefox 156.0.1 cases](../frontend/test/direct-connections-firefox-evidence-2026-11-06.json) cover both actual pages with normal/private warm caches and both pages with deliberately unavailable timing APIs. Firefox's privileged `PrivateBrowsingUtils` confirmed a real private window and private tab with permanent-private autostart disabled. Every cached fixture executed after reload with only one server hit and an independent `http-on-examine-cached-response` event. The existing collector retained its row after `clearResourceTimings()` produced an empty buffer and the next refresh ran. Missing APIs showed a warning despite independently logged HTTP loads. All cases had zero page errors, and source/harness hashes stayed unchanged. The historical blank table was not reproduced by ordinary warm-cache or private-window behavior; unavailable APIs were an explicit compatibility simulation, not Firefox's default behavior.

Reproduce with `node frontend/test/direct-connections-firefox.mjs /tmp/derpc-direct-connections-firefox.json`. The owned Firefox process's HTTP-channel log is independent of ResourceTiming, but may include browser background HTTP and cannot account for WebRTC or all OS traffic. The transport is explicitly stubbed for these UI checks. No further production change was needed; 43 focused collector/network/main tests passed. Owned browsers, profiles and temporary servers were cleaned up.

### Packaging and remaining gates

`scripts/check-release.mjs` checks the source checkpoint age, checkpoint/gateway markers in the built demo, all four assembled pages and their relative assets, initial payment controls, required release files and known literal leak patterns. It prints categories and paths, not matched secret values. It is read-only and offline; it does not establish arbitrary-secret absence, runtime payment behavior, public reachability or document quality. The root engine requirement now matches the documented Node 24 workflow.

A [fresh built-demo Firefox check](../frontend/test/public-gateway-browser-evidence-2026-11-06.json) on the current network still failed to complete startup through the public demonstration gateway. Six WebRTC ICE errors and Tor bootstrap/directory failures were observed; the worker never supplied a verified header/pin/read. The run stayed within 148 seconds total. A Firefox diagnostic-listener incompatibility consumed about 65 seconds before retry, leaving about 83 seconds of actual page observation; this is not a full 150-second startup measurement. No direct RPC/beacon HTTP request was observed, and payments remained off, but failed startup cannot establish functioning anonymity. The artifact was unchanged and owned browser/server processes were closed. Public gateway and hosted-site acceptance remain open.

[ARCHITECTURE.md](../ARCHITECTURE.md), [FEEDBACK.md](../FEEDBACK.md), and [SUBMISSION_DRAFT.md](SUBMISSION_DRAFT.md) now provide the technical reference, partner observations, form text and timed human-narrated recording script. README setup and `docs/tracks.md` reflect those materials and implemented capabilities. The team still supplies facts about human/code authorship where attribution is explicitly pending; no authorship or qualification has been invented.

Remaining external work: the team's public gateway/hosted-browser acceptance, independent operator configuration and authorized public ENS lifecycle transactions, the later paid funding/read/settlement/refund rollout, human recording/submission and required production reviews. The period-1904 cold-start requirement was completed by the later 19:54 UTC check above. The source and local test work do not substitute for the remaining outcomes; the later branch review also identifies missing provider fixes.

Suggested additional commit split, keeping these changes separate from the ENS milestone groups:

1. `provider: prefer selected gateway for pinned worker bundles` — `provider/src/transport/pinned-bootstrap.ts`, the resolver comments in `provider/src/config/mainnet.ts`, `provider/test/transport/pinned-bootstrap.test.ts` and `provider/test/transport/kps-bootstrap-live-2026-11-06.json`.
2. `frontend: retain and qualify browser traffic observations` — `frontend/src/direct-connections.ts`, its test and browser evidence, `frontend/src/network-check.ts`, `frontend/network-check.html`, `frontend/test/network-check.test.ts`, plus only the diagnostic import/callback/table changes in `frontend/src/main.ts` and `frontend/index.html`. Keep ENS/routing hunks with their milestone commits.
3. `scripts: check assembled release inputs and artifacts` — `scripts/check-release.mjs`, `frontend/test/release-check.test.ts`, `frontend/test/public-gateway-browser-evidence-2026-11-06.json`, and the Node engine correction in `package.json`.
4. `docs: prepare release and submission materials` — `ARCHITECTURE.md`, `FEEDBACK.md`, `specs/SUBMISSION_DRAFT.md`, `docs/tracks.md`, and the corresponding README, ANON_RPC, CONTEXT, layout, attribution and QA updates. Keep unrelated milestone documentation hunks with their owning change.

No staging, commits, deployments or external messages were performed for this continuation.

### Publication review

The requested read-only review of `specs/prompts/2026-11-05-grok-planning-chat.md` is complete. Private conversation/canvas links occur at lines 67, 209, 655, 671 and 859. Work context and other project strategy occur at lines 31, 35, 37, 45, 185, 189, 191, 193, 264, 279 and 581. Those are concrete team publication decisions; the existing flag at line 11 remains relevant. No credential-like material was detected in lines 1–1230, so this review identified no credential-rotation action. The transcript and its header were not edited, and no private URLs or conversation contents are reproduced here.

## Parallel follow-up — November 6, 13:48 UTC validation

At the team's request, four supporting agents implemented the isolated provider, gateway, diagnostic/payment-control and settlement fixes alongside the other Codex task's dashboard/onboarding work. The other task's active-writer lock rejected direct messages; its latest task record and shared-file state were inspected to avoid overlapping ownership. The only supporting change to its dashboard was an expired-listing display guard and regression.

| Finding | Current local result | Evidence |
| --- | --- | --- |
| QA-01 / QA-08 | Fixed: release validation rejects `kps:` prefixes and malformed/noncanonical SHA-256 certificate pins, including the appended fallback | Gateway tests and compatibility check against the installed KPS parser/decoder |
| QA-02 | Fixed: missing, malformed, partial or non-Tor observations are inconclusive; IPv6 forms are normalized before comparison | Diagnostic regressions and Chromium outage reproduction |
| QA-03 | Addressed by the other task's new onboarding flow and revised product direction | Staking/pricing explicitly planned; local draft export, current singular-endpoint limits and wrapper guide are visible; watcher-score and `.ops.derpc.eth` promises removed |
| QA-04 | Fixed: selection, pool eligibility and each execution request enforce expiry, including identity-lookup and delayed-response boundaries | Clock-advance/provider regressions; dashboard shows expired listings as unavailable while retaining past proof history |
| QA-05 | Fixed: pinned-header freshness is checked after completion and before cache/return; completion errors cannot retry or pay another operator | Real voucher-signing regression preserves one voucher, no second-operator payment and no outstanding reservation |
| QA-06 | Fixed for the reproduced lost-broadcast/expiry gap: durable expired transactions retain nonce reservations and replay their original signed bytes | Real local-chain integration with two journal restarts, reverted nonce 0, successful nonce 1, exact refund and retained transaction evidence |
| QA-07 | Fixed: payment rows and action buttons remain attached while their values/state change | DOM regressions and Chromium keyboard-focus reproduction |
| QA-09 | Fixed: explicit shell settings are preserved; historical log addresses are not copied unless still assigned to a current interface | Isolated helper tests use temporary files and fake commands; no actual services or environment files changed |

**Integrated validation:** 586 default tests passed: 53 contracts, 68 payments, 290 provider, 36 wrapper and 139 frontend. The same five opt-in ENS fork tests remain skipped. Workspace type checking and combined `pnpm build:site` passed. The release build used the explicitly supplied upstream demonstration gateway, not a newly deployed production gateway. Bundle-size warnings remain.

A fresh Firefox run against the integrated dashboard/provider through the current LAN gateway passed: worker ready in 3.9 seconds, authenticated headers 7.2 seconds later, worker pin and balance/storage/code reads verified at mainnet block **26356116**, simulated corruption rejected/excluded with successful failover, and state reads refused after shutdown. There were no page errors and no direct RPC/beacon requests in the HTTP trace. Payments remained off. This does not replace the outstanding hosted public-gateway or all-onion release checks.

**Settlement tradeoff:** replaying the original expired close can consume gas when it reverts, which releases its account nonce for later sessions. No new cancellation transaction or fee replacement is signed. Automatic fee bumping remains outside this correction; an originally signed transaction whose fees are no longer accepted can still require operator intervention. Existing funded sessions remain settleable after their operator listing expires.

Follow-up evidence: `/tmp/derpc-parallel-support-3hlnwtpq/` holds the full test/typecheck/build logs and integrated browser script, JSON and screenshot. `/tmp/derpc-diagnostic-fixed-results.json` and `/tmp/derpc-payment-focus-fixed.mjs` record the isolated UI checks. Tests use local chains/fixtures; no public transaction or deployment was made.

### Review and commit boundaries for the team

These boundaries apply to the pending changes. When a module is still untracked, include its corrected implementation in the original feature commit rather than manufacturing a defective earlier version. The other task's dashboard/onboarding split remains in [DEMO_WORKFLOW.md](DEMO_WORKFLOW.md).

| Order | Message | Files or hunks |
| --- | --- | --- |
| 1 | `frontend: validate gateway addresses and certificate pins` | `frontend/build/gateways.ts`, `frontend/test/gateways.test.ts` |
| 2 | `dev: preserve gateway configuration after network changes` | `scripts/dev-services.sh`, `frontend/test/dev-services.test.ts` |
| 3 | `frontend: mark incomplete isolation checks inconclusive` | `frontend/src/network-check.ts`, `frontend/test/network-check.test.ts` |
| 4 | `provider: recheck freshness after payment signing` | Freshness/completion hunks in `api/derpc.ts`, `pool/pool.ts`, `pool/pooled-reader.ts`; corresponding `execution-budget`, `extensions` and pool `lifecycle` tests |
| 5 | `provider: enforce operator listing expiry` | Expiry hunks in `api/derpc.ts`, `pool/pool.ts`; corresponding `extensions`, pool `lifecycle` and `pool` tests |
| 6 | `frontend: show expired operator listings as unavailable` | Expired-state guard in `frontend/src/operator-dashboard.ts` and its test; follows provider expiry and the dashboard feature |
| 7 | `frontend: preserve payment action focus during updates` | `frontend/src/payment-panel.ts`, `frontend/test/payment-panel.test.ts`; follows the baseline payment UI |
| 8 | `wrapper: recover settlement nonces after expiry` | `wrapper/src/payment-chain.ts`, `wrapper/src/payment.ts`, `wrapper/test/payment.test.ts`, `contracts/test/wrapper-payment.test.mjs` |
| 9 | `specs: record QA fixes and integrated validation` | This report; retain its existing layout/AI-attribution changes with the original report if not yet committed |

The two provider boundaries have verified review patches in `/tmp/derpc-provider-qa-fixes/`, relative to the pre-fix working tree. Their changes are already present; do not apply them again to the current tree. Nothing was staged or committed.

## Initial findings and reproductions

### QA-01 · P2 · An accepted gateway configuration prevents worker startup

**Location:** [frontend/build/gateways.ts](../frontend/build/gateways.ts), `gatewayHost` and `releaseGateways`.

Validation strips `kps:` from an address before checking it, but the emitted gateway list retains the prefix. The installed KPS parser rejects the prefixed address. The upstream worker constructs its gateway objects synchronously, so this exception prevents startup even when a valid fallback follows it.

**Reproduction:** `releaseGateways("kps:" + TOR_JS_DEMO_GATEWAY, TOR_JS_DEMO_GATEWAY)` succeeds; passing its first entry to the installed `@kpstreams/core` `parseAddress` throws `address: malformed`. The existing unit test positively accepts the prefix, so the passing suite misses this incompatibility.

**Correction:** either reject the prefix or normalize the emitted value. Verify build output against the parser used by the pinned worker, including a configured gateway plus fallback.

### QA-02 · P2 · Network diagnostics report successful isolation with no observations

**Location:** [frontend/src/network-check.ts](../frontend/src/network-check.ts), lines 119–132.

When all four exit probes fail, both exit sets are empty. Their empty intersection produces a green result: `key-a exits {} vs key-b exits {}: no overlap`. Successful JSON responses are also recorded before requiring a valid IP and `IsTor === true`.

**Reproduction:** run the actual diagnostic module with anonymous transport requests rejecting. Chromium showed four failed probe rows followed by the green isolation row, without JavaScript errors. This was an injected outage, not evidence about live Tor circuit isolation.

**Correction:** require valid successful Tor observations for both keys; otherwise show an inconclusive/unavailable result. Retain the existing qualification that observed exit separation is not proof of unlinkability.

### QA-03 · P2 · Public pages promise excluded or deferred operator features

**Location:** [web/src/pages/landing.ts](../web/src/pages/landing.ts), lines 85–98; [web/src/pages/operate.ts](../web/src/pages/operate.ts), lines 28–108.

The landing and operator pages promise stake-backed watcher scores, per-read revenue and `.ops.derpc.eth` names. The current release uses free curated operators, excludes staking and watcher scores, and defers payment rollout and independent ENS onboarding. The operator CTA leads only to a disabled preview with no link to the implemented wrapper runbook. A general roadmap disclaimer does not reconcile these specific claims.

**Reproduction:** open the landing page's operator panel and follow “Run an operator”; the conflicting claims render at desktop and mobile widths.

**Correction:** describe the free release and its actual operator setup, link the wrapper runbook, and label deferred ENS/payment capabilities consistently. Remove the unsupported staking/score promises.

### QA-04 · P2 · Expired discovered operators remain eligible through the provider API

**Location:** [provider/src/api/derpc.ts](../provider/src/api/derpc.ts), `validateOperators`/`setOperators`; [provider/src/pool/pool.ts](../provider/src/pool/pool.ts), `choose`.

The documented discovery flow passes discovered entries to `setOperators`, but provider eligibility considers exclusion and cooldown without enforcing listing expiry. After expiry, an uncached private read still reaches that operator. The demo's one-second expiry timer mitigates this for its UI; library and agent consumers have no equivalent protection or documented responsibility.

**Reproduction:** select a valid discovered-shaped operator, complete its identity/pin/proof checks using a recorded genuine proof, then advance the clock beyond expiry. `getTransactionCount` sends another `eth_getProof`, succeeds, and reports the operator as `eligible`.

**Correction:** carry expiry into provider eligibility, reject expired selections, prevent subsequent requests and define behavior for expiration during an operation. Add a clock-advance regression. This does not imply a forged proof was accepted.

### QA-05 · P2 · A paid read can become stale during signing and still return as verified

**Location:** [provider/src/pool/pool.ts](../provider/src/pool/pool.ts), lines 223–228; [provider/src/pool/pooled-reader.ts](../provider/src/pool/pooled-reader.ts), lines 40–45. The explicit verified-call API has the same ordering.

The proof operation checks header freshness, then awaits asynchronous payment completion. A header that crosses the freshness boundary during that await is cached and returned without another check.

**Reproduction:** an injected asynchronous payment callback crosses the freshness boundary after the recorded proof verifies. `getBalance` returns successfully while `status().lightClient.state` is already `stale`.

**Correction:** recheck freshness after asynchronous completion and immediately before caching/returning. Account for any voucher already created so refusal cannot cause duplicate payment. The current free release does not enable this payment path.

### QA-06 · P2 · An expired settlement leaves a nonce gap that stalls later sessions

**Location:** [wrapper/src/payment.ts](../wrapper/src/payment.ts), lines 126–135; [wrapper/src/payment-chain.ts](../wrapper/src/payment-chain.ts), lines 35–43.

If a journaled nonce-0 settlement never reaches the node and a second settlement is queued at nonce 1, expiring the first session stops rebroadcasting nonce 0. The allocator continues above the remaining pending nonces. Later transactions cannot mine until the missing nonce is consumed manually.

**Reproduction:** actual controller, store, allocator, typed vouchers and signed transactions with intercepted RPC responses. After the first session expires, the node pending nonce remains `0`, ticks rebroadcast only `[1]`, and the next allocation is `2`. No network transaction was sent.

**Correction:** reconcile the lowest missing nonce before allocating higher ones; durably replace an expired transaction or reuse the available nonce for an eligible settlement. Cover expiry and restart together. This affects operator settlement availability, not the free-read path, and no funds-conservation bypass was demonstrated.

### QA-07 · P2 · Payment action buttons lose keyboard focus every second

**Location:** [frontend/src/payment-panel.ts](../frontend/src/payment-panel.ts), lines 178–196.

The timer rebuilds the entire session table every second. Focused close, settlement-check, deposit-recovery and refund buttons are removed from the DOM, interrupting keyboard navigation.

**Reproduction:** render the real panel and `PaymentClient` with wallet calls stubbed in memory, focus “Close with operator”, and wait 1.2 seconds. Chromium's active element changes from `BUTTON` to `BODY`. No wallet transactions were made.

**Correction:** retain action elements while updating state, or deliberately preserve focus. Verify with a funded and a pending-deposit row. Payments are off by default, so this does not affect the current free-read flow.

## Lower-priority findings

- **QA-08 · P3 · Malformed gateway certificate hashes pass release validation.** `gatewayHost` only requires nonempty certificate text. `releaseGateways("8.8.8.8:12298:not-a-certificate", demo)` succeeds, whereas the transport's certificate decoder rejects it. Validate the expected SHA-256 multihash at build time. This fails during dialing and can leave only the demo fallback usable.
- **QA-09 · P3 · The development helper restores a stale address after a network change.** [scripts/dev-services.sh](../scripts/dev-services.sh), lines 25 and 44–51, reuses a listening gateway, trusts its historical startup log, and overwrites the configured address. The observed log advertised `10.116.160.58` while the current interface was `10.116.160.138`. Validate the address against current interfaces or preserve an explicit override. The helper was inspected, not run against the user's environment.

Other follow-ups: the root advertises Node `>=20` despite documenting Node 24 and directly executing TypeScript; no Node 20 runtime was available to reproduce that compatibility mismatch. `settlePayment` accepts an under-acknowledged amount and a loosely validated settlement shape; the demo independently verifies the escrow receipt before finalizing a row, so this was not classified as a funds bypass.

## Initial verification results

| Check | Result | Qualification |
| --- | --- | --- |
| Contracts tests | 52 passed, 5 skipped | Actual-mainnet ENS fork tests require explicit opt-in/RPC configuration and were not rerun here |
| Payments tests | 68 passed | Includes delegation, limits, concurrency and durable state |
| Provider tests | 278 passed | Includes proof attacks, Lodestar regressions, EVM bounds and fail-closed lifecycle |
| Wrapper tests | 35 passed | Includes proxy/payment filtering and journal shutdown regressions |
| Frontend tests | 86 passed | DOM, wallet binding, payment controls and gateway tests |
| **Default total** | **519 passed, 5 skipped** | `pnpm -r test`; no website test script exists |
| Workspace type checking | Passed | All five TypeScript packages |
| Solidity compilation | Passed | Solidity 0.8.30; registrar 4,137 bytes, escrow 3,812 bytes |
| Release build without public gateway variable | Correctly rejected | Negative configuration check |
| Combined `build:site` | Passed | Explicit public upstream demo gateway; not a production-owned gateway deployment |
| Docker Compose configuration | Passed | Harmless explicit environment values; no services deployed |
| Core documentation links | Passed | READMEs, context and roadmap local file targets |
| Source stability / tracked sensitive filenames | Passed | No concurrent source change during review; no tracked `.env` or key/certificate files found by filename check |

Build warnings remain: the largest frontend chunk is approximately 1.19 MB minified / 347 KB gzip, and Vite reports Node-module externalization warnings. These warnings alone do not demonstrate a browser failure. No new performance budget or exhaustive secret scan is claimed.

### Browser checks

- **Chromium 151:** nine representative website routes at 1440, 390 and 320 pixels, with no page JavaScript errors, failed HTTP responses, broken images or material page overflow. Directory search, empty state, verified-network filtering, URL persistence, Back navigation, copying and query escaping passed.
- **Demo UI:** no initial operator selection, payments off, selection gating, responsive layout and invalid ENS/onion/call form errors passed. These isolated form tests blocked external worker loading and do not prove live reads.
- **Fresh Firefox, built static release:** the pinned worker bundle was requested from jsDelivr, production debug handles were absent and payments were off. The upstream demo gateway produced repeated WebRTC ICE failures; no completed reads were obtained within 180 seconds. Observed HTTP requests were local assets plus the worker CDN, with no direct RPC/beacon fallback. WebRTC traffic is outside the HTTP request trace. This is an availability failure in this environment, not proof that the gateway is universally unavailable or that application verification is broken.
- **Fresh Firefox, local loopback gateway:** repeated ICE failures; still booting after 180 seconds, with reads pending. This did not establish a usable loopback WebRTC path.
- **Fresh Firefox, gateway at its current LAN address:** passed using a dedicated development server and fresh browser profile. Worker startup took 3.4 seconds, followed by 8.6 seconds for verified light-client readiness. At mainnet block **26355993**, the worker pin, WETH contract's ETH balance, the pair's WETH storage balance and the 3,124-byte contract code verified. The simulated corrupt balance was rejected and its operator excluded; a subsequent honest endpoint returned the same verified balance. Closing the worker refused all three state reads, and generic `eth_call` stayed refused. No page/console errors occurred. The only external HTTP request was the pinned worker CDN; no direct RPC/beacon request appeared. This tests public execution endpoints through Tor, not an all-onion operator path or a deployed static release.

### Dependency audit

`pnpm audit --prod --json` reported one high-severity advisory for optional Zod 3.25.76 via viem/abitype: [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). No production imports of `zod` or the separate `abitype/zod` export were found in application code, viem or ox; a reachable vulnerable collection-validation path was not established.

The full development audit reported six advisory records: four high, one moderate and one low. The additional records concern `ws` 8.13.0 under Ganache and `tmp` 0.0.33 under solc. These are development dependencies, not browser production services. They still warrant compatible updates or dependency-specific mitigations; the green application tests do not resolve them. Raw audit output records exact versions and dependency paths. No dependency changes were made during QA.

## Release evidence still required

1. A successful cold start and verified read/failover/shutdown sequence from the intended hosted public site through a production-owned gateway, including the required committee-period startup case. The failed public demo-gateway run does not clear this gate.
2. Reliable all-onion execution/consensus availability. Earlier live evidence in [OPERATIONS.md](OPERATIONS.md) remains historical evidence and was not relabeled as a fresh pass here.
3. For the later rollout: independent-operator ENS records and discovery, a public Hoodi paid read/settlement/refund cycle, settlement-cost measurements, and the required independent security/legal review. Deployment of the escrow alone does not complete these gates.
4. Submission materials and per-file AI attribution for code/assets when authorized by the team. This review does not fill the explicitly pending attribution sections.

## Reproduction and evidence

The local evidence directory is `/tmp/derpc-full-qa-8jjumkwe`: source hashes, default test log, release-build log, production/full dependency audits and fresh Firefox scripts/results. Review-specific reproductions are `/tmp/derpc-provider-expiry-qa.mts`, `/tmp/derpc-provider-freshness-qa.mts`, `/tmp/derpc-nonce-gap-qa.mjs`, `/tmp/derpc-payment-focus-qa.mjs` and `/tmp/derpc-diagnostic-qa.mjs`. Chromium observations are in `/tmp/derpc-frontend-qa.md` and its referenced JSON/screenshots. These are local QA artifacts, not checked-in test coverage.

The provider reproductions run with `node --experimental-transform-types`; the nonce-gap reproduction runs with `node`. They use synthetic identities and recorded proof fixtures, not user credentials. The browser test servers and browser processes owned by QA are shut down after collection.

Suggested documentation commit for the team: `specs: record full project QA findings`, containing this report plus its `REPO_LAYOUT.md` entry and `AI_USAGE.md` planning attribution. Implementation corrections should each include their relevant regression and stay split by the owning area; no files were staged or committed by QA.
