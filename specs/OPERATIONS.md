# ENS, operator and payment release gates

This is the operational checklist for issues [#44–62](https://github.com/r0bops/DeRPC/issues/44), requested by the team on November 6, 2026. [CONTEXT.md](CONTEXT.md) holds product decisions; [ROADMAP.md](ROADMAP.md) defines the wider project gates. An implementation, a local test, a live anonymous request, and a public-chain deployment prove different things. Keep their evidence separate.

**Current delivery order:** the free mainnet alpha is deployed at `derpc.eth.limo` and its hosted verified-read/shutdown flow passed Firefox checks. Maintain the release by observing a complete IPNS renewal cycle, arranging a second persistent pin and off-host recovery for the IPFS repository, and refreshing the trusted checkpoint before its November 12 expiry. Independent-operator ENS onboarding remains deferred; payments follow the free release.

**Release policy:** payment demonstrations use test funds. A production settlement chain and asset have not been approved. No external contract audit or legal-review result is recorded here. Do not infer either from unit tests or an automated code review.

## Open operator-signed registration, November 7

The user explicitly chose open registration and clarified that **the operator signs**, replacing the proposed approval-service flow and earlier curator-only minting. Initial owner-authorized namespace setup remains required. Once attached, operators create their own resolver, grant their separate endpoint updater and register from their own wallet; the parent owner does not approve each name. The [operator wallet guide](../contracts/README.md#join-from-an-operator-wallet) documents the local review command and durable receipt journal. No signer key is generated, received or used by the service.

The registrar retains owner moderation, 30-day maximum leases and its 128-entry proof layout. Delisting binds both operator and label, persists address/name bans and allows another label to use the vacated slot immediately. Reinstatement deliberately clears the exact bans. Existing active sibling entries remain unaffected. Free admission still allows Sybil identities, name squatting and capacity attacks; those are not solved by a wallet signature.

Use the [fresh open-registration first stage](../contracts/deployments/ens-open-registration-plan-1-2026-11-07.json), with its [two-source crosscheck](../contracts/deployments/ens-open-registration-plan-1-crosscheck-2026-11-07.json). At block **26359514**, both sources observed the parent subregistry still empty and reconstructed the same three zero-value proxy calls. Estimated gas differed: **1,694,836** versus **1,703,144**. The contract source hash is `0x9f7503ee65c72b815895ab33bf6fd847fbf544060aecf2f0bd52fb3f76032ee4`. The source change requires fresh subsequent registrar deployment and runtime-pin verification; old curator-only plans/reports below are historical, even where the first-stage factory calldata is unchanged. Both configured demos share the owner's address as their operator address, so this bootstrap still uses that same wallet in both roles.

The [final validation index](../contracts/deployments/ens-open-registration-validation-2026-11-07.json) records **seven passing fork tests**, the [exact-demo fork](../contracts/deployments/ens-open-registration-two-demo-final-tooling-evidence-2026-11-07.json) and [independent-operator enrollment](../contracts/deployments/ens-open-registration-independent-join-final-tooling-evidence-2026-11-07.json). The latter executes resolver, permission and registration calls while curator impersonation is disabled; subsequent bootstrap verification still succeeds with the newcomer active. All 22 source hashes stayed unchanged. Both disposable nodes were restored and stopped. A [final-tooling two-source check](../contracts/deployments/ens-open-registration-final-tooling-crosscheck-2026-11-07.json) at block 26359533 confirms the stored first-stage requests still match and the parent is unattached. These checks are local simulations and administrative observations, not public signatures, funding or consensus verification.

Final integration checks passed **159 contract/wallet tests**, **636 provider tests**, **63 affected UI/config tests**, all workspace typechecks, and isolated production builds of `web/` and `frontend/`. Eight opt-in fork tests were skipped by the default contract run; seven current scenarios passed separately, with the historical three-demo case left skipped. Public directory pins remain unset in the demo build.

Open registration also removes the assumption that every resolver was screened before admission. The provider now labels and excludes only deterministic resolver refusals established by host execution against authenticated state. Unproven errors, missing proofs, stale context and network deadlines remain fatal to discovery. All **636 provider tests** and its typecheck pass. Many slow entries can still exhaust the whole scan budget; no execution or network limits were raised.

Suggested commit split after the prior wallet-helper dependency:

1. `contracts: allow operator-signed registration with moderation` — registrar source and behavior tests, planner/receipt/lifecycle sender and moderation updates, matching existing tests.
2. `contracts: add self-service operator wallet enrollment` — `ens-join.mjs`, generic wallet-session hooks and tests, independent enrollment tests.
3. `provider: isolate authenticated resolver policy refusals` — host execution/discovery changes and their regression tests.
4. `contracts: record open-registration validation` — fresh preflights/plans, final-tooling crosscheck and fork reports/index. Earlier reports remain historical.
5. `web: explain open operator registration` — onboarding copy, refreshed pending-plan import and matching UI checks.
6. `docs: describe operator onboarding and admission limits` — current context, package guide, runbook, threat model, QA, layout and AI-use documentation.

No public transaction or site deployment was performed. Owner setup signatures, finalized proven discovery, a working independently operated gateway and public enrollment remain separate gates. Keep any old pending wallet request locked until reconciled; do not delete an old journal to start over with the changed source.

## Two separate proxy operators, November 7

The owner-signing handoff is implemented in [the local ENS wallet helper](../contracts/README.md#ensv2-deployment). The user reconfirmed these two names when requesting completion. Run it with the active configuration and retain its evidence directory; each wallet request is rechecked against two public administrative RPC sources, unknown submissions remain locked across reload/restart, and final manifest/directory-pin output requires full twelve-confirmation verification through both sources. A refresh/restart invalidates previously exported current pins until reverified. The helper does not sign, activate payments, publish website changes or bypass the independent-gateway guard. Owner signatures and the finalized anonymous directory test remain pending.

[Wallet-review evidence](../contracts/deployments/ens-wallet-review-evidence-2026-11-07.json): **109 contract tests passed, seven opt-in fork tests skipped** in this run, including ten backend and 25 browser-controller tests. Fresh Firefox with a mock extension confirmed wrong-network refusal, explicit mainnet switching, correct-owner checkbox/send enablement, the two-name roster and 375/1280px layout without errors. No signing method was called. Live administrative preparation agreed through two sources; all three first-stage entries remained unsent. That review used loopback port 8792 and retained its journal under `~/.local/share/derpc/ens-two-operators-2026-11-07/`. The old-source server was stopped before integrating open registration; its journal contained no submitted or pending transaction. Keep that historical journal and start a fresh source-bound session using the updated guide before signing.

Suggested commit after the two-operator preparation: `contracts: add staged ENS wallet deployment review` — `contracts/scripts/ens-wallet.mjs`, `contracts/scripts/ens-wallet-client.mjs`, their focused tests, the dated wallet-review evidence, the wallet section in `contracts/README.md` and related context/operations/layout/AI-use documentation. Keep the existing shared-file changes in their earlier logical commits; no files have been staged or committed by this change.

The user selected the first two existing proxies and clarified that each is a separate operator. The directory now prepares these two actual entries from the [active configuration](../contracts/deployments/ens-two-demo-operators-config-2026-11-07.json), with a per-operator review/download flow. Public providers remain a secondary bootstrap list. Demo-3 is outside this enrollment plan; the earlier three-entry artifacts below remain historical and must not be mixed with this plan.

The registration UI passed **42 focused tests**, frontend/web typechecks and [six Firefox desktop/mobile checks](../frontend/test/two-operator-registration-browser-evidence-2026-11-07.json). The displayed/downloadable singular entries and full first-stage plan match the source files. No wallet call, network probe or transaction is triggered by the review flow. Generic onboarding remains separate.

| Operator | Existing server | Endpoint-update key |
| --- | --- | --- |
| `demo-1.derpc.eth` | `209.250.237.225` | `0x0Fea008976e62d29714ba3398e6791131A629eB6` |
| `demo-2.derpc.eth` | `192.248.176.219` | `0x1d3beAB2c16422B214133DB122B1eC2c8dF66c8E` |

Both retain their existing singular RPC/beacon URLs and public identity names. No endpoint ID, shared plural record, new key or server migration is required. They share team ownership and signer `0x9E15a220Cc2cfcFa3381C5488434291EB65EAa78`; separate entries do not establish independence. [Fresh administrative observations](../wrapper/test/deployed-operators-observation-2026-11-07.json) confirm matching identities, chain ID 1 and available beacon headers on both servers. Payments remain off and demo-2's fault overlay was off. No service was changed.

The [unsigned first stage](../contracts/deployments/ens-two-demo-operators-plan-1-2026-11-07.json) contains three zero-value mainnet factory calls from the owner: deploy the UserRegistry and one dedicated resolver for each operator. Total estimated gas is **1,694,836**; wallet fees are additional. [The independent crosscheck](../contracts/deployments/ens-two-demo-operators-plan-1-crosscheck-2026-11-07.json) reconstructed identical wallet requests. The predicted subregistry is `0x7a315598b4979b3d9F463c1AA3647D368BD1Ea91`, with resolvers `0x9c75435f88a9C8F48963f229a397306610E92656` and `0x0Ed7Cb979f8670A9e3DE432367E6523B489A5c59`. These addresses are predictions, not public deployments. Refresh the plan before signing; preserve its receipts and `resumeConfig`, then prepare the registrar, permission/attachment and registration stages in order.

The [exact-config fork check](../contracts/deployments/ens-two-demo-operators-fork-evidence-2026-11-07.json) passed all four stages using 11 local transactions, both permitted endpoint rotations, two denied cross-resolver writes, ten denied protected-record writes, delisting and expired-lease renewal. It preserves the parent's website resolver. This is a disposable mainnet fork with local address impersonation and confirmations; it supplies no public signature, finality or anonymous discovery evidence.

The [new browser gateway observation](../wrapper/test/two-operator-gateway-readiness-2026-11-07.json) still fails before contacting either proxy. The current official upstream demo advertises the same independently operated gateway; its connection failed under unchanged budgets. The team's gateway remains declared and is correctly refused for these team-owned RPC services, including mixed gateway lists and key aliases. A working independent gateway, owner-signed registration stages and a finalized proven directory refresh remain the live gates. Native-Tor or loopback health checks do not replace them.

Suggested commit order: `contracts: prepare two separate team operator registrations` (new two-operator configuration, preflights, unsigned plan, crosscheck and exact-config fork test/evidence); `web: show real team operators and registration reviews` (pending-operator data, directory/onboarding/router, landing/demo copy and matching UI tests); `ops: record two-operator rollout readiness` (two dated wrapper observations plus README/context/roadmap/operations/layout/AI-usage changes). Leave the existing gateway guard and historical evidence intact.

## Pending-issue update, November 7

The [latest QA record](QA_REPORT.md#pending-issue-continuation--november-7) covers the delegated-key fix, six actual-code ENS fork checks and expanded payment measurements. The exact prepared three-demo deployment passed all four stages on a disposable local fork. Refresh the public preflight before signing; the local registrar address/runtime and simulated receipts do not configure the public directory.

The published `d90cc742` demo skipped its simulated liar after warmed reads because normal account affinity was retained. The local UI now resets that explicit demonstration, prioritizes the simulated endpoint and guards active reads. [Fresh Firefox on the isolated local production build](../frontend/test/public-gateway-firefox-local-fix-recheck-2026-11-07.json) passed 17 baseline plus six rejection/recovery gates through the public VPS. It also checks the teammate's local removal of external operator favicons. Publish the reviewed changes and repeat against the resulting CID before using the hosted demonstration in the final video; concurrent later website releases are not covered by these local results.

The [00:05 UTC operations observation](../web/deployment-ops-observation-2026-11-07.json) verifies the current signed IPNS record and current/rollback recursive pins. Its expiry corresponds to the explicit `d90cc742` release, so a complete automatic renewal cycle still needs observation. The retained `publish-uncertain` watermark is qualified by the exact accepted release tuple and successful public verification; it is not proof of failed publication. The existing proxy at `209.250.237.225` has about 62.59 GB free disk and 3.36 GB available memory for a second pin, but IPFS is not installed there. Existing encrypted IPNS-key backups do not establish a full IPFS-repository or gateway-key recovery plan. The local UDP listener/firewall decision in #17 remains open.

Suggested commits for this continuation, after the earlier ENS/release dependencies below:

| Order | Message | Files or specific hunks |
| --- | --- | --- |
| 1 | `payments: separate delegated keys from escrow authority` | `payments/src/client.ts`, `sponsored-client.ts`, `sponsored.ts`; `payments/test/agent-flow.test.ts`; `payments/README.md` |
| 2 | `frontend: make proof rejection demo deterministic` | Injection/control hunks in `frontend/src/main.ts` and related `frontend/test/main.test.ts` cases; `provider/test/api/derpc.test.ts` |
| 3 | `contracts: validate prepared ENS deployment on local fork` | `contracts/test/ens-fork.test.mjs`, `ens-endpoints-fork.mjs`, `ens-team-demo-fork.mjs`; `contracts/deployments/ens-team-demo-fork-evidence-2026-11-07.json` |
| 4 | `contracts: measure escrow recovery costs and sampled fees` | `contracts/scripts/payment-deploy-measure.mjs`; `contracts/deployments/payment-cost-measurement-2026-11-07.json`; gas-measurement hunk in `contracts/README.md` |
| 5 | `frontend: bind live checks to release artifacts` | `frontend/test/public-gateway-firefox.mjs` and its dated November 7 browser evidence |
| 6 | `docs: reconcile pending issues and validation evidence` | `web/deployment-ops-observation-2026-11-07.json`; this continuation's context, roadmap, milestone, QA, submission, release-runbook, layout and AI-usage hunks |

Shared files contain other agents' changes; review individual hunks rather than staging them wholesale. The existing website favicon removal and new server-side fault scenarios belong to their respective owners' commit groups.

## Public demo ENS integration preparation, November 6

### Operator directory and triggered server scenarios, November 7

The user requested actual operator entries and deliberate bad-response, unavailable-node and registration demonstrations. The local website now separates the three deployed team proxies, explicitly **ENS pending**, from the five public bootstrap services. Bootstrap aliases are not displayed or passed as ENS identities. Old saved choices and links remain compatible; matching placeholder strings do not authorize a subsequently discovered operator. Registration opens the existing onboarding draft and still requires the owner-signed ENS stages below.

The user explicitly requested triggering faults on two deployed servers. An optional loopback overlay is installed on **demo-2 (`192.248.176.219`)** and **demo-3 (`45.76.81.156`)**. Demo-1 was not changed. Both overlays default to off, retain their onion addresses and original wrapper caches, and are controlled through SSH. The [runbook](../wrapper/demo/README.md) gives activation, status, reset, installation and removal commands. Faults expire within five minutes; the WETH-only corruption and RPC-outage modes affect actual responses from that demo server during the window.

[Deployment evidence](../wrapper/test/demo-server-faults-evidence-2026-11-07.json) records matching deployed source hashes, successful proof rejection and recovery through server-loopback administration, a real HTTP 503 with automatic expiry, and both scenarios observed through their public onion services using native Tor. The first demo-2 onion attempt timed out at 45 seconds; a fresh SOCKS isolation key succeeded. Both modes were explicitly reset to off afterward. The live proof-consistency check uses an administratively read state root; it is not light-client consensus verification. The native Tor probe does not clear the pending browser Anon-RPC and independent-gateway gate.

Validation: **65 wrapper tests**, including the real proof verifier and pool handling recorded mainnet proofs; **392 frontend tests**; type checks and combined site build. [Local Firefox checks](../frontend/test/operator-scenarios-browser-evidence-2026-11-07.json) passed at 375, 768 and 1280 pixels and opened the registration draft. The public website has not been updated with these working-tree changes. No ENS transaction was sent and the downloadable wrapper release is unchanged.

Suggested team commit order after the existing ENS preparation changes below:

1. `frontend: separate bootstrap choices from ENS operator identities` — the bootstrap/provenance hunks in `frontend/src/main.ts`, `frontend/src/operator-dashboard.ts`, `frontend/index.html`, `frontend/test/main.test.ts` and `frontend/test/operator-dashboard.test.ts`. Keep concurrently prepared deployment-pin and local-liar fixes with their own changes.
2. `web: show deployed demo operators awaiting ENS enrollment` — `web/src/directory/model.ts`, `operators.ts`, `pending-operators.ts`; `web/src/pages/directory.ts`, `operator.ts`, `network.ts`; `web/src/ui.ts`; `frontend/test/operator-directory.test.ts` and the browser evidence. The test also needs the existing public ENS configuration and deployed-proxy readiness evidence from the preceding preparation commit.
3. `wrapper: add timed server-side demo faults` — `wrapper/demo/`, `wrapper/test/demo-faults.test.mjs`, `scripts/vps/install-demo-faults.sh`, `scripts/vps/demo-scenario.sh`, server-fault evidence, the server-scenario copy in `frontend/index.html`, and the related context/operations/layout/AI-usage notes. Review shared-file hunks separately from unrelated working-tree changes.

### Prepared ENS configuration

The user confirmed three separate names for the existing proxies. Their public identities and pool onion hostnames were read over SSH without changing services. All three are team-run `demo-proxy` entries and use `0x9E15a220Cc2cfcFa3381C5488434291EB65EAa78` as signer; they do not establish independent operators.

| Name | Administrative server | Endpoint-update address |
| --- | --- | --- |
| `demo-1.derpc.eth` | `209.250.237.225` | `0x0Fea008976e62d29714ba3398e6791131A629eB6` |
| `demo-2.derpc.eth` | `192.248.176.219` | `0x1d3beAB2c16422B214133DB122B1eC2c8dF66c8E` |
| `demo-3.derpc.eth` | `45.76.81.156` | `0x3F0d8e8cE6C0817fd7e23faD32998dD42c76D24D` |

The requested update keys were generated locally and encrypted to the owner's existing SSH public key. Recovery was checked in memory; no plaintext key file or private key was written to the repository. The encrypted archive is under the operator's local `~/.local/share/derpc/ens-hotkeys-2026-11-06-*/` directory. [Public-key metadata](../contracts/deployments/ens-demo-hotkeys-public-2026-11-06.json) records only addresses. Before later endpoint updates, recover the chosen key into the team's signing tool; do not print decrypted keys or put them into shell arguments.

The [public configuration](../contracts/deployments/ens-team-demo-config-2026-11-06.json) contains the actual onion endpoints and known gateway ownership, proposed lease expiry **2026-11-14 00:00 UTC**, and the owner wallet for the curator/deployer/cold-owner/operator/signer/free-listing-payee roles. No payments are enabled. [Fresh first-source](../contracts/deployments/ens-preflight-integration-2026-11-06.json) and [second-source](../contracts/deployments/ens-preflight-integration-second-source-2026-11-06.json) observations agree at block 26359170 that the parent has no subregistry and the upstream contract runtimes match their pins.

The [first unsigned deployment stage](../contracts/deployments/ens-team-demo-plan-1-2026-11-06.json) prepares four factory calls from the owner: one UserRegistry and three dedicated PermissionedResolvers. Transferred value is zero; the total estimate is **2,442,715 gas**, with fees determined by the signing wallet. A [second source reconstructed identical wallet requests, addresses and roles](../contracts/deployments/ens-team-demo-plan-1-crosscheck-2026-11-06.json). These are predictions, not deployments. Review the full calldata and role table, refresh the plan before signing, retain all four receipts and its `resumeConfig`, then rerun the planner for the registrar and subsequent stages. The existing parent resolver and website contenthash are preserved. No transaction has been sent.

The browser tests retain the team's gateway declaration and select the independently operated upstream demo gateway. Both attempts failed at the gateway connection before making any proxy request; production timeouts were unchanged. [Readiness evidence](../wrapper/test/deployed-proxy-readiness-2026-11-06.json) preserves the distinction between SSH inspection and anonymous proof verification. The failure could be remote or network-specific; it is not evidence of a proxy failure. A working separate gateway is needed under the current ownership guard. Do not erase the declaration to get around that guard.

Optional `VITE_ENS_DIRECTORY`/`DERPC_ENS_DIRECTORY` pins now bind the mainnet registry, registrar runtime and expected subregistry in local and GitHub builds. Configured pages require proven records and explicit refresh; the release checker compares the emitted `demo/ens-directory.json` with the intended pins and compiled runtime. [Release configuration](../scripts/vps/GITHUB_RELEASE.md#installed-access-and-configuration) describes the handoff from the verified deployment manifest. The current build remains unconfigured until the real registrar exists and its receipts/runtime have been checked.

Validation: **74 contract tests and 378 frontend tests passed**, with five opt-in ENS fork tests skipped in this run; frontend/web type checks passed. Both the unconfigured site and a separate configured build fixture passed all 56-file offline release checks. The fixture's synthetic pins stayed under `/tmp` and were never published. The deployed-proxy runner also passed 25 offline input/ownership/identity checks. Initial full-suite attempts were blocked by sandbox restrictions on subprocesses and loopback servers; reruns with those capabilities passed. These results do not replace wallet receipts, finalized proven discovery, public rotation/delisting or an independent operator.

Suggested commit split, without staging or committing:

1. `contracts: allow one operator with multiple endpoints` — `contracts/scripts/ens-common.mjs`, `contracts/scripts/ens-lifecycle.mjs`, their endpoint/lifecycle tests, `contracts/README.md`, and the onboarding count copy/test. This does not change the selected three-entry deployment.
2. `frontend: bind proven ENS discovery to release pins` — the ENS config parser/tests, Vite asset emission, dashboard fields/refresh tests, release checker/tests and optional CI/release environment wiring.
3. `wrapper: validate deployed proxy identity and gateway ownership` — `wrapper/test/onion-availability.mjs` and its run instructions.
4. `ops: prepare three demo ENS registrations` — public configuration/keys/unsigned plan/crosscheck/preflights, proxy readiness evidence and related context/roadmap/operations/release/AI-usage notes. Exclude the pre-existing proxy installer and its layout hunk unless the team separately includes them.

## Public mainnet alpha, November 6

**The public gateway, IPFS pin and ENS website are deployed and verified.** The supplied VPS is `45.76.81.48`, accessed through the local `derpc-vps`
SSH alias. It runs gateway and IPFS as separate unprivileged, boot-enabled system
services. [Service configuration and commands](../scripts/vps/README.md) and the
[deployment record](../web/deployment-vps-2026-11-06.json) record versions, hashes,
limits, public ports and restart checks. IPFS administration remains loopback-only.

The owner's transaction `0xc68829ea02c0be675c8c187c4bc20a48cea9ab70e9d179994668c5c36a982bd9`
was confirmed by two administrative RPC sources with a successful canonical receipt
and 13 confirmations at observation. The ENS app wrapped the exact prepared setter
in `multicall`; the sender matched the owner and the transferred value was zero.
The [publication record](../web/ens-website-publication-2026-11-06.json) includes all
55 matching HTTPS asset hashes. [Fresh Firefox on the actual ENS domain](../frontend/test/ens-hosted-firefox-evidence-2026-11-06.json)
passed all 17 checks in 50.9 seconds, verifying pin/balance/storage/code at finalized
block 26358155 through only the VPS gateway. Payments stayed off; unsupported calls
and shutdown reads were refused; no external HTTP or asset/page errors appeared.
The local-preview observations below remain historical evidence of the earlier stage.

The [current release](../web/deployment-ens-ipfs-2026-11-06.json) is pinned at:

```text
ipfs://bafybeidksnvtvc7n4ciiflw7o2gc563lqaxtulmqix2cxvddvhc4sv24me
```

Its frozen static directory and CAR are under
`web/out/ens-ipfs-vps-only-2026-11-06/`. A fresh online IPFS node discovered the
VPS through public IPFS discovery, without importing the CAR or manually connecting a peer, and
retrieved all **55 files** with matching SHA-256 hashes. The pin and gateway identity
survived service restarts. One initial CLI pin probe raced IPFS startup and caused a
repository-lock retry; a repeated restart waited for the API and passed cleanly.
There is one persistent pinning host; redundant pinning/off-host backups are not
established by these checks.

The built gateway list contains only
`45.76.81.48:12298:uEiDF_BrtBaFV_aXYw0Eo4OY73zCVlT96GTYm-wNqYiDopg`.
Release builds now honor the explicit shell list. Upstream tor-js shuffles its
selection pool, so silently adding the demo gateway was not a reliable backup
policy. **239 frontend tests**, frontend type checking, the assembled build and the
55-file offline release check passed after this correction.

[Fresh Firefox evidence](../frontend/test/public-gateway-firefox-evidence-2026-11-06.json)
passed all 17 checks in 44.5 seconds. The production files were delivered through a
local Kubo gateway at the release CID; RPC transport used the public VPS. Native
WebRTC candidate statistics identified only `45.76.81.48:12298`, including received
worker traffic. Worker pin, balance, storage and code verified; raw `eth_call` was
refused, payments stayed off, and shutdown refused reads with no subsequent observed
HTTP. No external HTTP, page errors or failed assets were observed. The authenticated
header advanced during the run; do not describe every read as one block. Run the
[opt-in checker](../frontend/test/public-gateway-firefox.mjs) against the final HTTPS
URL after publication. That local observation alone did not clear the public ENS page gate; the later
HTTPS run above does.

The public HTTPS preflight could not serve the CID: ipfs.io/dweb.link returned a
service-worker migration notice with HTTP 429, Pinata/inbrowser.link returned 403,
and the IPFS2 preview resolved to `0.0.0.0` from both tested hosts. Native public IPFS
retrieval passed instead. The subsequent owner-signed contenthash update and final `derpc.eth.limo` HTTPS
checks passed as recorded above.

The [unsigned website transaction](../web/ens-website-transaction-2026-11-06.json)
sets only `derpc.eth`'s contenthash on Ethereum mainnet. At block **26358109**, two
administrative RPC sources agreed on the owner, resolver and empty record, and both
simulations succeeded. The [complete direct-link audit](../web/ens-website-link-audit-2026-11-06.json)
found only `derpc.eth` linked to record bundle 1. The owner and existing contract
administrator `0x00c2d95c074A772468657b39D0d4768648147e9d` both have root record,
link, upgrade and administration rights; this is not owner-only control. No roles
are changed by the prepared transaction. The owner subsequently signed the exact website setter inside an ENS-app multicall;
its receipt, record and HTTPS delivery have now been checked.
Independent operator enrollment remains a separate deferred action. The later team decision permits clearly labelled team-run wrappers for interim mainnet registration; their deployment and finalized discovery evidence are still required and cannot establish independent ownership.

The hosting decision remains ENS/IPFS through `derpc.eth.limo`; Vercel was rejected
and both temporary deployments and their project were removed. The
[historical deployment record](../web/deployment-mainnet-alpha-2026-11-06.json)
retains the earlier static asset checks and failed demo-gateway startup. Those
results do not replace the new VPS observations. Payments remain disabled.

The period-1904 startup check also [passed at 19:54 UTC](../provider/test/light-client/period-1904-evidence-2026-11-06.json)
from the original period-1903 checkpoint with forced updates disabled. The build's
checkpoint reaches its seven-day startup limit on **November 12 at 17:07:35 UTC**;
ship a trusted refresh before then. The [integrated provider cold start](../provider/test/light-client/period-1904-integration-evidence-2026-11-06.json) also passed through the public VPS at 21:51 UTC, verifying pin and balance at finalized block 26358539 in period 1904. All 38 source hashes stayed unchanged; there were no direct RPC/beacon requests or calls after close. This harness used a local page. The published CID predates the integrated fixes: rebuild, publish and rerun hosted checks before attributing those fixes to the public site. Retain prior published CIDs when updating.

### Stable IPNS address active in ENS

The dedicated VPS key `derpc-website` now publishes:

```text
ipns://k51qzi5uqu5dip6ttqcmj10rokc1dq8ppmppbo05grxwha1yvabumx7k1k9jhc
```

It targets the unchanged, already verified release CID above. Two fresh nodes
resolved the name, and the public signed record's signature, target and expiry
were independently checked. Its encrypted off-host backup restored the same name.
Initial DHT publication timed out; publication succeeded after configuring an
explicit HTTP publisher. Kubo is configured to renew every four hours with 48-hour
validity; a complete renewal cycle has not yet been observed. The initial publisher
checks reused immutable-CID asset evidence; the later ENS migration checks below
include a fresh download of all 55 HTTPS files.

The owner signed transaction
`0x279ae1501ad3df887e4d470ce8423523e68628a147ff34091fac3248d8c51587`.
Two administrative RPC sources confirmed a successful canonical receipt and
the expected contenthash at observation block 26358631, with 18 confirmations of inclusion block 26358614; this does not claim finalization. The transaction
also set the `ETHGlobal` text record to the IPNS URI. All 55 HTTPS files match;
gateway response headers identify the IPNS path and expected CID. See the
[migration evidence](../web/ens-ipns-publication-2026-11-06.json).
Fresh Firefox passed all 17 browser gates in 43.3 seconds, including verified
pin/balance/storage/code at finalized block 26358571, payment-off/default-call
refusal and shutdown with no direct HTTP RPC/beacon traffic. The first attempt
passed reads/shutdown but recorded a canceled logo request during navigation;
the unchanged checker passed on a fresh rerun. Both outcomes are retained in the
[browser evidence](../frontend/test/ipns-hosted-firefox-evidence-2026-11-06.json).
The agent sent no transaction. Future releases reuse the key. The `release-ens.yml`
workflow now requests publication through the restricted VPS handler after checking
the source commit, pinned CID and complete published website. See the
[runbook](../scripts/vps/IPNS.md) and [public evidence](../web/deployment-ipns-2026-11-06.json).
The VPS publishing key now authorizes new application/verifier code without another
Ethereum signature. The migration keeps the same release CID, so it does not publish
the later integrated fixes. No keys or local backup archives belong in the repository.

### GitHub IPNS automation, November 6

The `release-ens.yml` workflow now handles pushes to `main` and manual releases.
It verifies the exact clean commit/CAR, uses an offline-validating forced SSH
command to pin it, checks independent retrieval, rechecks the current `main` SHA,
publishes the fixed IPNS name and verifies its public signature plus all HTTPS files.
The existing GitHub credential was reused; the IPNS key stays on the VPS.
The `ens-production` environment was restricted to the `main` branch.

The installed command was exercised through its actual restricted SSH credential
using the already live CID. It rejected a conflicting retry and a shell-style
command. Publication timed out after saving the signed record; the exact durable
accepted tuple, renewed public validity and all 55 HTTPS files then verified.
The workflow therefore handles uncertainty only through those explicit checks.
Native retrieval also passed all 55 files using auto routing with an explicit VPS
connection. This does not claim exclusive peer delivery or automatic discovery.

Validation: 58 JavaScript release checks, 22 Python command checks including actual
offline CAR validation, frontend type checking, actionlint 1.7.12 and shell syntax.
The [evidence](../web/deployment-github-ipns-2026-11-06.json) distinguishes the local
same-CID rehearsal's sentinel run/source values from a real GitHub Actions run.
The first automatic run, [42305110614](https://github.com/r0bops/DeRPC/actions/runs/42305110614),
passed the build and VPS pin but timed out after 30 seconds at its first independent
IPFS root listing. It skipped publication. A later unchanged fresh-node check
retrieved all 55 files of the same CID. The exact network delay remains unproven.
The verifier now makes up to three attempts for timed-out connect/list/cat calls
on the same isolated daemon, retaining the 30-second request and eight-minute total
bounds. Integrity failures remain terminal. Seven regression cases bring the
verifier suite to 48 passing tests; frontend type checking and a live 55-file check
also passed. The user subsequently authorized committing and pushing the fixes.

A separate team push started run 42307096196 while investigating; it passed native
retrieval and published using the original verifier. Its HTTPS check failed for
eight minutes on unchanged CSS with a cached old root header, despite matching
file bytes and a valid signed new IPNS target. The verifier now checks every normal
URL's bytes first; a stale but valid root header additionally requires a
release-specific query response with the exact new root, IPNS path and expected
hash. Both response bodies count toward the byte limit. All 55 live HTTPS files
passed with the final fix locally. The final verifier suite passed 61 tests and
frontend type checking, including 20 new regressions across both failures.
The authorized fixes subsequently passed [Actions run 42310022450](https://github.com/r0bops/DeRPC/actions/runs/42310022450).
The later [d90cc742 release](https://github.com/r0bops/DeRPC/actions/runs/42314676419) passed as well.
Existing unrelated integration changes retain their own validation requirements.
See [GITHUB_RELEASE.md](../scripts/vps/GITHUB_RELEASE.md).

Authorized follow-up commits: `40c96ce` (`release: harden website deployment verification`)
for `scripts/verify-site-release.mjs` and `frontend/test/site-release.test.ts`, then
`docs: record deployment timeout and verification` for `scripts/vps/GITHUB_RELEASE.md`,
`web/deployment-github-ipns-2026-11-06.json`, `specs/CONTEXT.md`, `specs/OPERATIONS.md`,
`specs/ROADMAP.md` and `AI_USAGE.md`. These fixes are now published; the failed runs above remain historical observations.

Suggested team split, reconciling with any already recorded local commits:

1. `ops: restrict and order IPNS releases` — VPS helper, wrapper, installer and tests.
2. `release: publish verified main builds through IPNS` — artifact/state validators,
   independent verifier and tests, workflow/action changes and Python cache ignore.
3. `docs: record GitHub IPNS release readiness` — public rehearsal evidence and
   matching runbook/context/roadmap/layout/threat/AI attribution updates.

The user explicitly authorized the follow-up commits and push after the failure
investigation. Credentials, CARs, Python caches and unrelated integration changes
remain outside these commits.

### Downloadable operator packages, November 6

The user selected Linux x64 and ARM64 and accepted Docker or a standalone binary.
Prebuilt Docker archives reuse the existing Node wrapper and separate Tor service.
They include images, checksums, Compose, a public configuration example and a
launcher; operator hosts do not need Node, pnpm, a checkout or registry credentials.
The free package exposes only the pool onion service. Onion keys stay in the
explicit `derpc-wrapper_onion-keys` volume, and installation never replaces `.env`.

The local x64 archive passed 58 wrapper tests, type checking, isolated image checks
including the in-container self-test, and install/reinstall checks with no Node
command in the host PATH. Its [evidence](../wrapper/test/docker-release-evidence-2026-11-06.json)
explicitly records a dirty local build; it is not the clean release artifact.
The workflow builds each architecture on its own native runner and requires both
before creating an exact-commit draft. Existing release assets are never replaced.
[Release 0.1.0](https://github.com/r0bops/DeRPC/releases/tag/wrapper-v0.1.0) was published
as an experimental prerelease from clean commit `03d0419`. Both native builds and
installer checks passed in [run 42313333619](https://github.com/r0bops/DeRPC/actions/runs/42313333619);
all four attached assets and checksum files were checked. A follow-up workflow
guard checks paginated release lists because lookup by tag can miss a draft.
Public onion reachability, enrollment and real-node acceptance remain separate
from these offline checks. See [operator instructions](../wrapper/release/README.md)
and [maintainer workflow](../wrapper/README.md#downloadable-docker-releases).

Commit boundaries: runtime/self-test and free-pool Tor configuration; release
builder, image smoke test and workflow; then distribution documentation/evidence.

## Deployment boundaries

| Component | Network and authority | Required evidence |
| --- | --- | --- |
| Verified reads | Ethereum mainnet; the client's pinned checkpoint and host-side verifier authenticate finalized state. | Fresh verified block, account/storage/code proofs, and a trace with no direct RPC fallback. |
| ENS directory | ENSv2 on mainnet, under `derpc.eth`; the name owner controls the parent pointer and the registrar curator controls admission. | Actual factory/registry/resolver addresses, role state, transaction receipts, and discovery through Anon-RPC. |
| Operator wrapper | An operator's mainnet execution and beacon nodes, reached through its onion service. | Local setup self-test, live worker-to-onion proof and beacon requests, reciprocal identity check, and failure tests. |
| Test payments | A separate configured payment chain and escrow; the payer's wallet deposits and the operator settles. | Testnet deployment receipt, runtime-code verification, funded session, signed vouchers and a closing receipt with payout/refund. |
| Real payments | Undecided until the gates below pass. | Proven payee, measured total costs, independent contract review, and legal review for the actual operating arrangement. |

The chain an operator serves and the chain it is paid on are independent. Mainnet read verification does not verify a payment chain. Administrative deployment tools and the wrapper's payment-chain client have their own RPC connection; they are not an exception that the browser's verified-read provider can use as a fallback.

The public test escrow is deployed on **Hoodi (560048)**. ENS deployment and verified execution reads remain on Ethereum mainnet. The escrow also supports Sepolia test payments: the pinned light client's inability to verify Sepolia reads does not prevent deploying or using the escrow there. Neither test-chain choice selects a production settlement chain or asset.

## Evidence ledger

This table deliberately leaves live and external gates open until there is a reproducible artifact or receipt. A local mock ENS registry is useful for contract tests but is not an ENSv2 deployment.

An earlier combined validation run passed **507 tests** across contracts (40), payments (68), provider (278), wrapper (35) and frontend (86), plus **5 separately run ENS fork checks**. Workspace typecheck, Solidity compilation and the combined site build also passed. Later validation is recorded in the dated sections below. These checks support the implementation evidence below; they do not substitute for public deployment receipts or independent review.

A subsequent wallet-connection fix passed **47 contract tests** (including 16 wallet-helper checks; the five fork checks were skipped in this follow-up run). Isolated Firefox checks covered missing and delayed providers, selecting an announced MetaMask provider with another injected wallet present, visible errors, and reload protection after pending/submitted mock transactions. The user's next screenshot confirmed MetaMask detection and the matching sender on chain 4221, so review correctly remained disabled. An explicit testnet-switch action and adjacent network explanation were then added: **21 focused wallet-helper tests** passed, and Firefox mock-wallet checks exercised switching from 4221 to Hoodi, adding an unknown Hoodi network, and refusing review when a wallet reports success without switching. No transaction was sent during these checks. The user subsequently signed the real Hoodi deployment described below; the agent only performed read-only receipt/code verification.

| Issue | Implementation or local evidence | Remaining completion evidence |
| --- | --- | --- |
| #44 — operator subregistry | Two live administrative RPC sources agree on an empty `derpc.eth` subregistry pointer and upstream runtime hashes. The staged unsigned planner/receipt verifier passes five checks against a local fork of actual mainnet contracts. | Real operator configuration, wallet-sent factory deployment, parent attachment and 2–3 non-transferable subnames; verified addresses, roles and receipts. |
| #45 — resolver records | The planner creates one resolver per operator and scopes each hot key to `derpc.endpoint`; final verification audits roles and role-event history. | On-chain records, endpoint-only hot-key grant, and a failed attempt by that key to alter another record. |
| #46 — discovery | `provider/src/discovery/ens.ts` labels list/records independently, preserves user selection, and rejects expired/removed entries. Twenty-nine focused tests use controlled ENS metadata plus real worker-pin proof evidence. | Live discovery of the deployed operator directory and UI confirmation of those labels and choice semantics. |
| #47 — provable list | `OperatorRegistrar.sol` stores fixed-size entries; `discovery/registrar.ts` reads proofs against a pinned runtime hash. Independent tries and the [actual contract-to-discovery integration](../contracts/deployments/ens-fork-discovery-evidence.json) verify membership/payees, altered proofs and list changes against one local root. | Registrar review, deployed runtime pin and live list/payee proofs after list changes at a single verified block. |
| #48 — verified execution | Host EVM with proven account/storage/code access, bounded execution and CCIP refusal; 62 focused tests now distinguish resource exhaustion from genuine reverts while preserving handled child failures. A live browser call to the actual ENSv2 resolver returned an authenticated empty `derpc.eth` URL record through the onion. | Generic fully on-chain ENS name/hierarchy resolution is implemented, with later evidence below. Contract/fork compatibility stays limited by the documented executor; the resolver result does not establish the undeployed operator directory. |
| #49 — onion reads | Real Firefox proof/beacon requests and a one-run onion/exit latency comparison passed; `wrapper/test/live-browser.mjs` reproduces the check. | Publish the onion in the deployed ENS records (#45). Observed routes do not prove account unlinkability. |
| #50 — filtering wrapper | `wrapper/` contains the RPC filter, limits, finalized cache and Tor compose stack. Local filtering/HTTP tests, payment-capable Docker build and live failure checks passed. | Local implementation gate met in disclosed `demo-proxy` mode. Each later node deployment still runs setup; independent ownership is not inferred. |
| #51 — operator beacon API | Four bounded routes; real-BLS fixture tests cover failed bootstrap, invalid updates, all configured endpoints, deadlines and cancellation. Abandoned Lodestar sync/retry loops stop through the pinned lifecycle patch. Live onion beacon sync passed. | Local implementation gate met. Automatic endpoint switching after startup is outside this startup-fallback feature. |
| #52 — reciprocal identity | Wrapper document and client name/signer/chain checks are implemented; mismatch/rotation unit tests and live mismatch rejection passed. | Live ENS-to-onion binding; claims must still reflect the strength of the ENS read. |
| #53 — operator setup | Setup passed against the live demo proxy. An encrypted restore drill regenerated both onion identities offline and recovered the proxy configuration/token with original permissions; wrong-key recovery was rejected. | Local setup and retained encrypted backup gates met. Off-device backup retention is an operational follow-up, not established by the local drill. |
| #54 — personal node | Separate token listener/cache and memory-only credentials; live authenticated reads/fallback passed. Firefox UI checks found no token or private hostname in observed DOM, storage, logs or host HTTP surfaces; reload forgot them. | Local personal service gate met. The worker intentionally receives request headers; this is not a general process-memory or infrastructure-log audit. |
| #55 — gateway separation | Wrapper has no gateway; provider selection and discovery now reject declared or independently known same-operator pairings before candidate identity/proof traffic. Tests cover matching gateway keys behind different addresses and zero candidate requests. Live evidence explicitly discloses shared demo ownership. | Publish actual gateway declarations with the ENS records. The demo explicitly shares ownership; unknown ownership cannot be detected from an address alone. |
| #56 — session escrow | `QueryEscrow.sol` compiles and local lifecycle/replay/refund tests pass. The user deployed it on Hoodi; the checked manifest and second-source verification record matching creation/runtime bytecode and 12 confirmations. | Public testnet deployment gate met. Independent contract review is still required before real funds. |
| #57 — client vouchers | `PaymentClient` and provider hooks reserve credit and sign only after full host verification. Focused tests cover real signatures, freshness, concurrency, late exclusion and timeouts; local HTTP/EVM integration proves bad proofs/cache hits earn no payment. | A public test-payment read cycle and its final settlement receipt. Browser sessions intentionally keep keys only in memory. |
| #58 — wrapper settlement | Confirmed-chain checks, frozen price, durable vouchers/transaction journal and scheduler are implemented; 35 wrapper tests and typecheck pass. Local HTTP/EVM integration covers deposit, final voucher, restart, settlement and refund. | Public testnet closing receipt, operator deployment/restart exercise and gas-funded settlement before the refund boundary. |
| #59 — price/payee records | Discovery parses price, payee, payment-chain and escrow records with distinct payee/record proof labels; session terms freeze in the payment client. | Published records and paid UI evidence; real funds require a proven payee and authenticated escrow terms. |
| #60 — paid demo | Off-by-default UI loads a receipt-verified escrow manifest, checks wallet network/runtime and uses selected ENS payment terms. Free browser demo checks passed. | Actual paid ENS operator and wrapper, funded test wallet, deposit, verified-read/lying-operator counters, final voucher and closing payout/refund receipts. |
| #61 — app/agent payment | Delegated browser keys obtain bounded read authorizations from a durable coordinator; payment follows independent proof verification. The 68 payment tests and actual HTTP/wrapper/Ganache integration cover caps, replay, revocation, expiry/recovery and settlement (20 paid, 980 refunded). | Deployment with the app's real funding/header verifiers, authenticated grant/revoke administration and live app-signer exercise. A server payer does not establish a supported server anonymity runtime. |
| #62 — real-fund readiness | The decision template, cost method and counsel brief below are ready. | Measured candidate-chain costs, explicit chain/asset decision, proven payee, review findings resolved and an actual legal-review outcome. |

The [earlier fresh-cache lifecycle check](../wrapper/test/final-lifecycle-evidence-2026-11-06.json) verified the Lodestar patch in Firefox: 21.147-second startup through an onion beacon, then a 2.473-second proof-verified read through the explicitly selected MEVBlocker Tor-exit route at block 26355641. Closing refused another read and produced zero further transport calls during the one-second observation. Its all-onion execution attempts hit identity/proof deadlines. The later successful all-onion check and separately observed descriptor/rendezvous recovery are recorded below; they do not retroactively establish the cause of those uninstrumented failures.

## ENS and wrapper hardening, November 6

The continuation passed **718 default tests**: 59 contracts, 68 payments, 399 provider, 36 wrapper and 156 frontend. The default suite skips five opt-in ENS fork tests; those five separately passed against actual pinned ENS bytecode, including the new lifecycle pipeline. Six new lifecycle unit tests plus those five fork tests passed again after receipt/canonical-event hardening. Workspace type checking and `pnpm build:site` passed. The release package uses the explicitly supplied upstream demonstration gateway for build validation, not a newly deployed production gateway.

| Area | Result and evidence | Limit |
| --- | --- | --- |
| Directory authorization | Ten-minute lifetime capped by block timestamp + 30 minutes; 24 dedicated tests cover expiry, cached/in-flight reads, rollback, same-block replay, metadata downgrade, failed/cancelled refresh, restricted recovery and payment boundaries. | A newer finalized proven snapshot is needed to renew authority; a near-expiry interrupted scan may require an explicit retry. No deployed operator directory was introduced. |
| Discovery completeness | Incomplete local execution aborts the entire scan; genuine authenticated reverts and invalid records can reject individual candidates. Gateway separation precedes probes. | Availability failures are not ownership or honesty verdicts. |
| Dashboard | Snapshot block/hash, age/deadline and stale-read state; administrative refresh and restrictive/stop changes remain usable. Responsive Firefox fixtures passed at 375/768/1280 px. | Fixture UI checks do not prove public ENS activity or a live gateway. |
| Lifecycle tooling | [CLI and runbook](../contracts/README.md#ens-operator-lifecycle), [local plan example](../contracts/deployments/ens-lifecycle-fork-example.json), and [actual-code fork evidence](../contracts/deployments/ens-lifecycle-fork-evidence.json) cover rotation, both renewal authorities, expired-active recovery and token-preserving delisting. | Unsigned and read-only. No public transaction, new permission grant, enrollment or verified browser refresh. Same-block interference can conservatively refuse a legitimate transaction; do not resubmit merely because verification refused. |
| All-onion path | [Current-source report](../wrapper/test/onion-availability-evidence-2026-11-06.json): block 26356531, startup 15.836 s, pin/balance 18.636 s, storage 2.387 s; all client consensus/execution traffic used the onion, shutdown refused reads with zero subsequent calls during the observation. | Fresh browser over existing local gateway and running demo-proxy/Tor service; same-party ownership, mock ENS identity, payments off, no sustained-uptime or hosted-release claim. |
| Threat model | [Standalone model](../THREAT_MODEL.md) records host/worker/ENS/wrapper/payment boundaries, controls, exposure and unresolved gates. | Documentation and automated review do not constitute independent audit or qualified legal review. |

The diagnostic used production timeouts unchanged. In a separate frozen-source run, structured worker diagnostics showed hidden-service descriptor/circuit failure and rendezvous recovery before HTTP; local wrapper identity and upstream proofs were responsive. The final report distinguishes that diagnosis from its successful current-source check. Reproduce the focused route with the public `test:live` variables and `node wrapper/test/onion-availability.mjs`; the runner saves bounded request/body timing and errors without introducing an exit fallback.

At this earlier checkpoint, the remaining code included M1-B, general ENS resolution and lifecycle display integration; the later checkpoint below records their implementation. Current external gates include operator registrations and finalized lifecycle observations, independent ownership, sustained gateway/onion availability, publication of the integrated fixes, the public paid funding/read/settlement/refund cycle, app deployment configuration and required production/economic/security/legal decisions and reviews. The recorded public website and both period-1904 cold-start checks passed as described above. Payments stay at the end of the delivery order. Startup recovery (#34) remains a release regression case; the reviewed outage (#35), cache (#38) and block-selector (#39) fixes are integrated with the newer ENS/payment implementation. See [QA_REPORT.md](QA_REPORT.md).

Earlier proposed ENS lifecycle split (superseded by the local commit history):

1. `provider: distinguish execution limits from contract reverts` — `provider/src/execution/verified-call.ts` and its execution tests.
2. `provider: reject incomplete ENS snapshots before routing` — `provider/src/discovery/ens.ts`, `provider/test/discovery/ens.test.ts` and the `gatewayOwners` forwarding change in `provider/src/api/derpc.ts`.
3. `provider: bound ENS directory snapshot authorization` — new `api/directory-snapshot.ts` and `test/api/directory-snapshot.test.ts`; related changes in `api/derpc.ts`, `api/eip1193.ts`, `pool/pool.ts`, `src/index.ts` and `test/api/automatic-routing.test.ts`.
4. `frontend: show ENS snapshot validity and pause stale reads` — new `src/directory-freshness.ts` and its test, plus snapshot-related `main.ts`, `index.html`, `style.css` and `test/main.test.ts` changes.
5. `contracts: add scoped ENS lifecycle tooling` — `contracts/scripts/ens-lifecycle.mjs`, its six unit tests, the action template and lifecycle instructions in `contracts/README.md`.
6. `test: verify ENS lifecycle on a mainnet fork` — `contracts/test/ens-lifecycle-fork.mjs`, integration changes in `ens-fork.test.mjs` and the two clearly local lifecycle evidence/example JSON files.
7. `wrapper: diagnose and record all-onion availability` — `wrapper/test/onion-availability.mjs`, its dated sanitized evidence and the matching runbook section.
8. `docs: record ENS lifecycle controls and threat boundaries` — `THREAT_MODEL.md`, corresponding README/provider-guide and spec updates, `REPO_LAYOUT.md`, `AI_USAGE.md`.

Shared files required the documented hunk boundaries. The ENS lifecycle and snapshot changes are recorded in the integrated history; the earlier proposed split is not an outstanding staging queue.

### Live onion observation, November 6

The local wrapper checks used Firefox, the pinned tor-js 0.4.4 worker (`5b62f358…ec818b`), and the onion `g7nasyegiclqszahjp6jnkdrvlzntfams6bgawi6caaprlleq4mc2eid.onion`. Both `/rpc` and beacon requests used that service. The final saved run verified mainnet block **26355418**, hash `0xd4732709695a425e826a0d489c06a4a400d990126ced254d80285edb7684f4b9`. Worker startup plus beacon sync took **20.091 s**; the subsequent worker-pin check and first balance read took **19.067 s**. A proof benchmark took **5.831 s** through the onion versus **0.818 s** through the exit endpoint. These are single-run observations, not an uptime or comparative-performance guarantee.

In the same browser, verified local execution called the existing ENSv2 resolver `0xF645Ba7C7aE2A6915d0B904F39D4AadD7d899B59` with `resolve(dnsName("derpc.eth"), text(namehash("derpc.eth"), "url"))`. It returned an authenticated empty string at that block in **21.779 s**. The host fetched proofs/code through the onion instead of trusting a remote call result. This demonstrates actual proxy/resolver execution; it does not show new operator names or payment records were registered.

An additional saved run resolved `url`, `description` and `derpc.operators` together with the resolver's multicall at mainnet block **26355450** in **25.294 s**. All three authenticated values were empty. The execution trace contained **9 `eth_getProof` and 3 `eth_getCode` calls, with zero upstream `eth_call`**; its only external browser HTTP request was the worker download. This validates the batched resolver path without implying those empty records publish an operator list.

The expanded run rejected a mismatched identity, rejected a personal request without its token (401), proved an authenticated personal-node read, and fell back from an unavailable personal service to a chosen pool operator. After `close()`, a further read failed with zero additional transport calls. The test report omits tokens and the personal hostname.

The wrapper forwarded to public execution/beacon services and identified itself as `demo-proxy`. Its `check.derpc.eth` identity was a local test claim, **not a registered ENS name**. The same team ran the gateway and wrapper. That shared ownership is exactly the correlation risk the production pairing rule excludes. The browser HTTP trace contained the CDN worker download and local app assets, with no external direct RPC/beacon request; WebRTC transport establishment is a separate connection. The [sanitized live report](../wrapper/test/live-evidence-2026-11-06.json) is validation evidence, not an ENS or payment deployment manifest. Run `pnpm --filter @derpc/wrapper test:live` with the configuration in [the wrapper runbook](../wrapper/README.md#live-browser-check).

## Multiple endpoints and verified ENS, November 6

M1-B now separates the operator from its individual nodes. A versioned `derpc.endpoints` record carries up to eight endpoints within 4096 UTF-8 bytes. Discovery validates the complete record, matches each wrapper's node ID and keeps usable siblings when a node probe fails. Selection chooses the operator first; eight nodes do not give it eight selection weights. Per-node health remains separate, while ranking uses bounded actual observations across the group.

An authenticated rotation can replace every node URL without spreading an account to another operator: continuity requires the same proven ENS owner and signer. A new URL inherits no old node health, while the old destination's invalid-proof exclusion survives relabeling. Each selected pool retains its own authentication evidence, so reusing a same-block snapshot lease cannot retroactively authenticate earlier explicit claims. Plural payment configurations remain refused.

The dashboard groups nodes under one operator checkbox, retains source-aware saved choices, and tracks imported lifecycle evidence separately from proven directory state. Its receipt comparison establishes only that expected fields or absence are observed in a fresh authenticated snapshot; it does not prove receipt inclusion or transaction causality. The onboarding page converts a reviewed draft into an unsigned operator configuration fragment with explicit role and lease fields. Complete-config preflight, signatures and public enrollment remain separate.

General on-chain ENS resolution is available through `resolveEns` when verified calls are enabled, or the optional `@derpc/provider/ens` helper. A single local EVM invocation proves the hierarchy and resolver path. The [recorded mainnet evidence](../provider/test/fixtures/ens-mainnet-execution-evidence-2026-11-06.json) covers seven name/profile results and two corruption refusals using actual account/storage/code proofs at block 26356786. Its capture used administrative RPC and an injected state root; the nine offline tests make no light-client or anonymity claim. Content and off-chain URLs are never fetched.

That implementation checkpoint passed **1004 default tests**: 65 contracts, 68 payments, 576 provider, 58 wrapper and 237 frontend. This includes the current concurrent release/diagnostics changes, not only M1-B additions. The five opt-in ENS tests were skipped in that run and separately passed against actual ENS bytecode on a local fork. The [plural lifecycle evidence](../contracts/deployments/ens-endpoints-fork-evidence.json) covers fresh plural deployment, atomic migration in both directions, whole-list rotation, denied permissions, provenance rejection and reorg handling. Independent focused reviews found no remaining concrete blocker at this checkpoint; they are not an independent production audit.

The [wrapper packaging report](../wrapper/test/multiendpoint-packaging-evidence-2026-11-06.json) records a successful Docker build, identity checks, invalid configuration refusal and shared-schema compatibility. Responsive dashboard and onboarding fixtures passed at 375/768/1280 px without external HTTP or page errors. Workspace type checking and the combined static-site build passed; the build still uses the explicitly supplied upstream demonstration gateway and is not a new public-gateway deployment. Live sibling-onion results remain separate from these automated/local-fork checks.

The [final live sibling-onion report](../wrapper/test/multiendpoint-evidence-2026-11-06.json) passed in Firefox at authenticated mainnet block **26356914**. Header startup took 31.541 s; sequential public-fixture readiness reads took 22.245 s for node-a (including the worker pin) and 19.890 s for node-b. After both served, the group selected node-b; its controlled HTTP 503 caused a verified node-a result in **14.605 s**. The same account remained on node-a. Only after explicitly adding MEV Blocker did a second controlled outage route to it, through Tor, in **3.103 s**. Owned RPC gates observed at most one concurrent execution request. No production timeout or cooldown was changed.

The separate optional live ENS stage resolved `derpc.eth`'s `url` record through the complete hierarchy in **26.489 s**, using 14 `eth_getProof` and six `eth_getCode` requests, with zero remote `eth_call`. The proven value was empty; it does not publish an operator list. Shutdown refused another read and produced zero additional calls over the one-second observation. Source hashes matched before/after and still matched the saved source at review. Temporary wrappers, keys, Tor container, browser and test server were removed.

This live evidence uses a mock operator ENS identity, same-party gateway/proxies and public upstreams. It does not demonstrate public operator enrollment, finalized directory rotation/delisting, independent node ownership, sustained uptime or a hosted production gateway. Earlier attempts are retained honestly: one never reached transport because the machine's network address changed; another correctly skipped a cooling-down sibling and exposed an invalid test precondition. The successful scenario establishes both nodes' readiness before forcing failures.

The original local demo, directory and wallet-review services remain available. The machine switched network interfaces during live validation; the stale local gateway host in the ignored frontend configuration was updated while retaining its certificate and port. The existing demo now serves that current setting. No private configuration belongs in a commit.

Earlier proposed M1-B order (superseded by the local commit history):

1. `provider: validate versioned endpoint records` — `operators/endpoints.ts`, endpoint identity changes and their tests.
2. `provider: select operators before their endpoints` — `pool/pool.ts` and the pool selection/group tests.
3. `provider: preserve proven operator groups through rotation` — grouped discovery and API changes, public exports, discovery tests and `api/multi-endpoint-routing.test.ts`. Keep the earlier snapshot-lifetime hunks in their preceding checkpoint commit.
4. `provider: resolve on-chain ENS names against proven state` — `execution/verified-ens.ts`, its unit tests, the optional package export, lazy API method/types and `api/resolve-ens.test.ts`.
5. `test: record mainnet ENS execution proofs` — the dated proof/evidence JSON and `execution/verified-ens-mainnet.test.ts`.
6. `contracts: manage plural ENS endpoint records atomically` — plural configuration/planner/verifier/lifecycle changes, unit/fork coverage, public templates, clearly local evidence and the matching contract runbook.
7. `wrapper: support free multi-endpoint operator identities` — proxy/main/setup/Compose changes, backup configuration coverage, setup tests, packaging evidence and operator instructions.
8. `frontend: group operator endpoints and track ENS updates` — grouping and lifecycle helpers, dashboard/main/index/style changes and their tests. Preserve the separate concurrent connection-diagnostics work in its own commit.
9. `web: convert operator drafts into ENS endpoint-list fragments` — draft converter, operator page/styles, onboarding tests and the Viem dependency/lockfile change. Review unrelated preexisting lockfile hunks separately.
10. `test: exercise sibling onion endpoint failover` — the isolated live runner and its dated sanitized report, with only the observed claims in the wrapper runbook.
11. `docs: record multi-endpoint behavior and remaining release gates` — this checkpoint, provider/root guides, threat model, context/roadmap/milestone/workflow and layout/planning attribution. These docs accompany reviewed implementation, not public deployment.

## Operator rollout

1. Read [the wrapper runbook](../wrapper/README.md). Bind node APIs to loopback, enable the required proof history and light-client serving, then run setup. A proof at `latest` is insufficient: the self-test must request the finalized block.
2. Back up onion keys in encrypted storage; the [isolated restoration drill](../wrapper/test/backup-restore-evidence-2026-11-06.json) demonstrates identity/config recovery without publishing restored Tor descriptors. Keep personal tokens, onion keys and settlement keys separate, and outside images, source control and logs. A personal hostname is never listed in ENS.
3. Run the live check through the pinned browser worker. Record successful proof verification, the beacon path, identity, timings, corrupt-response rejection and anonymous-network failure. A loopback `curl` success alone does not satisfy this step.
4. Publish only the public pool endpoint and the declared capabilities that were actually tested. Mark public-node forwarders as demo proxies. Do not claim no logs, independent infrastructure or unverifiable operator behavior.
5. Check gateway ownership before enabling the operator in a client. Choose an independent gateway when ownership is known. If a demonstration shares ownership, disclose it prominently rather than describing it as a production privacy configuration.

## ENS rollout and trust

Deploy a UserRegistry through the ENSv2 factory and attach it to `derpc.eth`. Each operator gets a separate resolver because resolver roles are not scoped per name. Grant an operator's hot key only the `derpc.endpoint` text-key permission. Grant the registrar registration and renewal permissions; do not grant a person global unregister or name-transfer rights. Record the complete role state, including admin and upgrade permissions, not only the roles intended by the deployment script.

The [ENS deployment runbook](../contracts/README.md#ensv2-deployment) provides the preflight, staged unsigned planner, configuration templates and receipt-verification commands. Its [mainnet preflight](../contracts/deployments/ens-preflight-mainnet.json) is explicitly an administrative observation, not a host-verified ENS resolution. The planner preserves the existing parent resolver; discovery uses the registrar pin rather than requiring a new parent `derpc.operators` record.

The list is curated. The `derpc.eth` owner can repoint the subregistry, and the registrar curator admits and delists operators. There is no stake, slashing or fee for registration. Delisting from the registrar need not burn an ENS name: the client must remove the inactive entry immediately on refresh, while the underlying token expires according to its lease.

There are three distinct claims:

| Discovery mode | What is authenticated |
| --- | --- |
| Index and resolver calls through Anon-RPC | Transport is anonymous; the list and records remain **unverified discovery**. A malicious answer can redirect queries or show a false payee, even though supported account reads still require valid proofs. |
| Storage proofs of a pinned registrar | The fixed-layout list and its payees are authenticated against the finalized root **at that pinned contract**. This alone does not prove ENS parent pointers or resolver records. |
| Local ENS execution against proven state | Only the hierarchy and records actually resolved with authenticated code/state, supported block context and bounded local execution may be labelled proven. A CCIP-Read/off-chain requirement is refused. |

The wrapper's reciprocal document confirms what the reached endpoint says it serves. It does not repair an unverified ENS lookup. Changing an onion key requires an endpoint-record update and a fresh reciprocal check; the onion handshake is evidence for that connection, not a transferable signature proving operator conduct to third parties.

## Payment rollout

Use the escrow's test deployment flow described in [contracts/README.md](../contracts/README.md). Confirm the chain ID, deployed runtime and escrow address before opening a session. Copy the price, payee, chain and escrow terms when the session opens; later ENS price edits do not change that session.

The deployed Hoodi escrow is **`0x9053513aCA73bAc0aF6a9942fd93832fd313B0bb`**, created by `0x9E15a220Cc2cfcFa3381C5488434291EB65EAa78` in [transaction `0xb8b53e…7955`](https://hoodi.etherscan.io/tx/0xb8b53eaebe08d00d8d9e976a6897be5f8e5b145fd59052ac6be7ed11b36a7955), block **3962188**. The [verified deployment manifest](../contracts/deployments/payment-hoodi-deployment-2026-11-06.json) is the record to import into the test-payment UI and reference from operator ENS configurations. The [PublicNode cross-check](../contracts/deployments/payment-hoodi-crosscheck-2026-11-06.json) independently agrees with the ethPandaOps RPC on the canonical receipt, creator/derived address and exact reviewed creation/runtime bytecode. Both checks observed 12 confirmations; the block was not finalized at verification time. These are administrative RPC checks, not light-client proofs.

The public deployment used **892,743 gas**, costing **0.000897098867181885 test ETH** at the receipt's effective gas price. This measures deployment only; no public deposit, paid read, close or refund receipt has been recorded yet.

The [original unsigned plan](../contracts/deployments/payment-hoodi-plan-2026-11-06.json) is retained unchanged as the reviewed input, including its earlier preparation status and gas/balance sample. It is not the deployed-contract manifest. For any fresh deployment, refresh the preflight before the wallet owner reviews and sends the request. The loopback review helper makes no automatic transaction and blocks retries after an uncertain submission; its wallet selector supports EIP-6963, visible connection errors and explicit testnet switching. See the [wallet troubleshooting instructions](../contracts/README.md).

`contracts/test/wrapper-payment.test.mjs` exercises the real HTTP wrapper, payment-chain adapter, durable journal and deployed Ganache escrow together. Host verification checks generated cryptographic proofs and local execution; the test also checks cache/no-charge, corrupt-proof/no-charge, final voucher delivery, restart recovery, closing payment and refund. Its header source and anonymous transport are test doubles. It establishes local payment integration, not Tor routing, consensus verification or a public-chain payment receipt.

A separate [container check](../wrapper/test/payment-container-evidence-2026-11-06.json) ran the built image, accepted a real mainnet proof checked against the earlier browser-authenticated root, retained a 10-wei voucher across restart and confirmed a local-chain close paying 10 wei and refunding 9,990. This verifies packaging and durable-state wiring over loopback. It does not combine anonymous browser traffic with public payment settlement; [the wrapper runbook](../wrapper/README.md#local-container-payment-check) gives the reproduction commands.

For each chosen paid operator, test the following sequence:

1. A wallet opens a funded session for its operator and a disposable session signing key. Record the deposit receipt and refund deadline.
2. A successful uncached read verifies in the host before the cumulative voucher increases. A deliberately invalid proof and a client-cache hit each leave the voucher total unchanged.
3. Parallel reads respect the agreed credit window. A failover uses the second operator's own session and does not transfer credit between operators.
4. The client flushes its last voucher even when it sends no later query. The wrapper persists the highest accepted total and can recover it after a restart.
5. Stop new requests before the settlement safety margin. The operator closes before the refund deadline. Check the operator's payment and the payer's remainder from the receipt and balances. A rejecting recipient must not prevent the other party from receiving its share; any deferred withdrawal must be visible.
6. In a separate session that the operator does not close, check that an early refund fails and the payer can refund after the deadline. Confirm an old voucher cannot close that session afterward.

**Paid queries are linkable to the paying account.** Session identifiers and cumulative vouchers deliberately link requests to a funded session. Tor protects the route to the operator; it does not hide the payer or query contents. The wallet's deposit/top-up/refund traffic and the operator's payment-chain traffic are outside the anonymous read worker. The host holds the disposable session key; it never passes signing capability or that private key to the untrusted worker. App-funded delegation adds the app's signer/coordinator to the spending trust model.

The client creates separate read and close authorizations. They authorize wrapper work and closure but are not claimable escrow vouchers. The SDK spend limit and concurrency window constrain a cooperative client; the escrow deposit is the hard on-chain cap if its signing key is compromised. A top-up does not silently raise the SDK spending limit. Fresh browser sessions keep the signer only in memory and lose it on reload; do not restore a session without reconciling its highest signed total.

For app sponsorship, the app funds one escrow session per operator and retains the escrow key. Browsers sign exact read intents with capped, revocable request keys. Before authorizing wrapper access, the app durably allocates both per-user and session exposure. It signs a spending voucher only after independently verifying completion against its own authenticated header source. Invalid or abandoned work consumes its reserved allowance but earns no payment; cancellation or restart cannot restore that allowance. At most four short-lived authorizations are unfinished by default. Expiry frees a concurrency slot, not spending capacity. Revocation stops new authorizations; already issued work remains bounded by its original deadline.

A leaked request key can consume its remaining grant. A leaked escrow key can sign up to the session deposit. The coordinator sees sponsored query evidence and links users to it. State proofs establish correctness, not which operator supplied the evidence. The app's signer, verifier and durable store remain trusted spending components.

### App coordinator example

The server-only `@derpc/payments/node` export supplies `FileDelegationStore` and `serveSponsoredCoordinator`. Linux, Node 24 and util-linux `flock` are required. One helper owns both the exclusive kernel lock and all file IO; each commit syncs a private temporary file, renames it, and syncs the directory before acknowledging. Competing writers fail; helper loss fails the old store closed.

```sh
node payments/examples/coordinator.mjs /absolute/path/app-coordinator.mjs
node payments/examples/sponsored-read.mjs /absolute/path/app-reader.mjs
```

The [example guide](../payments/examples/README.md) specifies actual funded-session configuration, frozen price, private key file, durable directory, grants, authenticated funding/header sources and injected anonymous transports. No default signer, proof verifier, funded session or direct read RPC is substituted. `SponsoredPaymentClient` holds only the delegated key and checks read-authorizations/vouchers against the funded session key's public address.

`payments/examples/read-evidence.ts` independently verifies balance, nonce, storage and code against the sponsor's own authenticated mainnet state. `sponsored-reader.ts` collects and verifies the browser's evidence through an injected anonymous sender. It does not make a browser success flag sufficient for payment. This example refuses `eth_call`; a custom call requires its own bounded execution-witness verifier binding the full input. This does not establish a conforming anonymous Node runtime.

The loopback service exposes signed `POST /authorize` and `POST /complete`, with bounded bodies, concurrency and deadlines. Grant/revoke and terminal `prepareClose()` stay in trusted application administration; delegated users cannot close the shared session. The app delivers the final voucher and close authorization to the wrapper. Preserve exact signed intents and evidence to recover an uncertain completion without allocating a second nonce.

Never delete a funded ledger or restore an older backup: that could restore consumed allowance. Reopen the same durable directory and retry the exact intent after an uncertain write. If the ledger is lost, retire/refund the session and create a new one. Persisted protocol mode and frozen session parameters prevent mixing the older post-proof-only signer with the sponsored flow. The default settlement margin is 600 seconds and cannot be reduced below 60 seconds.

**November 7 hardening (#61):** the delegated request key must differ from the escrow session key. Both SDK construction and coordinator grant/request paths enforce this, including old persisted grants. The [payment guide](../payments/README.md) explains that a raw escrow-key holder can bypass a local SDK cap, and that the coordinator must be outside the agent's trust boundary. Deposit top-ups do not increase delegated allowances or the fixed coordinator budget. All 71 payment tests passed, including cap exhaustion, trusted allowance increases, revocation and restart recovery.

## Real-fund decision record (#62)

Keep the production choice **unset** until this record has evidence. Native test ETH demonstrates the mechanism; it is not a production asset recommendation or proof that payments create operator income.

| Field | Required record |
| --- | --- |
| Candidate chain and asset | Chain ID, asset address or native denomination, confirmation/finality policy and who runs the payment-chain RPC. |
| Deployment identity | Source/compiler settings, bytecode/runtime hash, address and verified receipt. No upgrade or owner-controlled diversion path. |
| Deposit cost | Actual `open` receipt: gas used, effective gas price, native total fee and any separately charged data fee. Deposit value is refundable principal, not a transaction fee. |
| Settlement cost | Actual `close` receipt under representative session/signature data and both recipient types used in practice. Include deferred-withdrawal cost where relevant. |
| Other lifecycle costs | Top-up and timeout-refund receipts, minimum useful deposit, settlement retry costs and required gas reserve. |
| Economic comparison | `(deposit fee + settlement fee + other applicable fees) / accepted uncached reads`, using measured session volume. Report the denomination and measurement time. |
| Payee authentication | Proven source and verified block; also document how the correct registrar/hierarchy and payment-contract identity are authenticated. |
| Review | Independent contract review, resolved findings, operational key/persistence review and legal-review outcome for the actual deployment. |
| Decision | Named human decision-maker, date, chosen chain/asset, spending limits and reasons grounded in the records above. |

Local EVM gas measurements can compare contract paths and catch regressions. They do not establish live fee levels, L2 data charges, finality, congestion, availability or a recommended settlement chain. A testnet receipt also cannot establish operator income or mainnet economics.

The November 6 local measurement recorded **144,501 gas for opening** and **66,023 gas for closing**, or **210,524 gas** for that successful lifecycle with EOA recipients. The [contract guide](../contracts/README.md#local-gas-measurement) records the source/runtime hashes, local fee values and reproduction command. Candidate public-chain receipts and their complete fees remain missing, so the production chain/asset decision remains open.

The [November 7 deterministic measurement](../contracts/deployments/payment-cost-measurement-2026-11-07.json) expands this to 16 receipts: opening 144,501 gas, closing 66,039, timeout refund 49,917, deferred close through a rejecting fixture 114,697, and each successful credit withdrawal 50,332. The changed close calldata explains why it is a separate sample, not a replacement for the historical receipt. Exact gas/fees reproduced across two runs; consolidation checked all 197 receipt, cycle and projection calculations. Three read-only public fee observations at 00:05 UTC provide explicitly labelled local-gas projections and per-read volume sensitivity. They do not measure public lifecycle fees, actual demand, representative smart wallets or a required reserve. The outstanding decision fields above remain unset.

### Brief for qualified counsel

This is a request for review, not a legal conclusion. Supply counsel with the final escrow source and deployment configuration, the client/wrapper flows, and the following facts. Do not mark the legal gate complete merely because this brief exists.

- Identify the people/entities operating the application, directory, gateways and paid RPC services, their locations, intended users and launch jurisdictions.
- Explain the actual control of funds: payer deposits, the operator's signed cumulative claim, timeout refunds, deferred withdrawals, absence of an owner/upgrade path, and every party that can control keys or spending permissions.
- Describe app-funded delegation, caps, revocation and the consequences of a leaked user key or compromised app signer. Distinguish a browser session key from the operator's settlement key.
- Provide the chosen chain/asset, fees, expected volumes, recipient policies and whether any operator or intermediary has discretionary control of user funds.
- Disclose what data each party can observe or retain: payer/session linkability, query contents, IP/timing at the gateway, direct wallet RPC traffic and public-chain records. Document actual retention and access practices rather than assumed no-log behavior.
- Ask counsel to identify applicable obligations, required product changes, user disclosures, terms, recordkeeping and unresolved issues for that specific arrangement. Ask whether any intended claims about custody, privacy or operator payments are supportable.
- Record counsel's name, review date, scope, assumptions, written outcome and the team's implementation of required changes. Keep sensitive advice outside the public repository; record a permitted summary and release decision here.

The externally required inputs are a usable authorized deployment wallet, test funds and transaction receipts; operator/node infrastructure and public endpoints for the intended release; and actual independent review and counsel. Agents can prepare and verify artifacts, but cannot replace these with simulated receipts or a self-issued approval.

## Earlier integration commit plan (historical)

This was the preparation plan for the earlier combined changes. At the team's explicit request, that non-Markdown work was recorded in **30 local commits**, from `1a6164a` through `96439b4`, with no push. Payment and wrapper package implementations are therefore already tracked. The actual dependency-ordered history supersedes the proposed grouping below; retain this table as a rationale, not as an outstanding staging queue. Later ENS and provider changes are recorded in the integrated history; publication evidence and documentation are reconciled separately. Markdown was excluded from that earlier recorded series.

The table covers the ENS, wrapper and payment implementation. Keep the separate directory/brand work (`web/`, `brand/`, `docs/`, `scripts/assemble-site.mjs` and site-build scripts) in its own series. Do not include `.superstack/`, credentials, generated builds, local deployment keys or machine state.

### Dependency order and commit boundaries

Paths below are relative to the repository root. “Hunks” means only the named behavior in a shared file, not the whole file. Each row includes its associated package scripts/dependencies, public exports, workspace registration and layout entries when first needed.

| Order | Commit message | Include | Depends on |
| --- | --- | --- | --- |
| 1 | `contracts: add prepaid escrow and deployment checks` | `contracts/src/QueryEscrow.sol`, `contracts/scripts/compile.mjs`, `contracts/scripts/payment-deploy.mjs`, `contracts/test/payment-deploy.test.mjs`, and the escrow setup/cases from `contracts/test/contracts.test.mjs`; payment settings template, `contracts/scripts/payment-deploy-measure.mjs`, local gas report and toolchain setup. | Existing workspace |
| 2 | `contracts: add local wallet deployment review` | `contracts/scripts/payment-wallet.mjs`, `contracts/scripts/payment-wallet-client.mjs`, `contracts/test/payment-wallet.test.mjs` and the Hoodi unsigned plan. Add the corresponding commands/runbook sections. | 1 |
| 2a | `contracts: record verified Hoodi escrow deployment` | `contracts/deployments/payment-hoodi-deployment-2026-11-06.json`, `contracts/deployments/payment-hoodi-crosscheck-2026-11-06.json` and the public deployment section in `contracts/README.md`. Reconcile project-wide status/layout/attribution in 20. | 1–2 |
| 3 | `contracts: add curated ENS operator registrar` | `contracts/src/OperatorRegistrar.sol`, `contracts/test/ens-registrar.test.mjs`, and the registrar setup/cases from `contracts/test/contracts.test.mjs`. | 1 |
| 4 | `contracts: plan and verify ENS deployments` | `contracts/scripts/ens-*.mjs`, ENS configuration/receipt templates, upstream/preflight records, `contracts/test/ens-plan.test.mjs`, `contracts/test/ens-fork.test.mjs`, fork evidence and ENS runbook sections. | 3 |
| 5 | `payments: add bounded verified-read voucher sessions` | Final `payments/src/protocol.ts` and `payments/src/client.ts`, their exports, `payments/test/client.test.ts` and `payments/test/client-lifecycle.test.ts`; package/TypeScript setup. Include the corrected captured-session return from the start. Do not yet export delegation or sponsorship. | Existing workspace; matches escrow ABI from 1 |
| 6 | `payments: enforce delegated spending caps and replay limits` | `payments/src/delegation.ts`, its exports, `payments/test/delegation.test.ts` and `payments/test/adversarial.test.ts`. The adversarial tests import both client and delegation, so they belong here. | 5 |
| 7 | `payments: persist delegation state across crashes` | `payments/src/node-store.ts`, `payments/src/node-worker.ts`, `payments/src/node-codec.ts`, the `./node` export, `payments/test/node-store.test.ts`, `payments/test/node-acknowledgement.test.ts` and `payments/test/helpers/store-process.mjs`. Defer coordinator re-exports until 17. | 6 |
| 8 | `wrapper: add a durable journal with safe shutdown` | Final `wrapper/src/payment-store.ts` and `wrapper/test/payment-store-lifecycle.test.ts`; wrapper package/TypeScript setup with only the scripts/dependencies this module needs. Includes operation tracking, lock retention and the shared close promise from the start. No controller, chain adapter or proxy changes. | Existing workspace |
| 9 | `wrapper: filter RPC and beacon requests with personal authentication` | Non-payment portions of `wrapper/src/proxy.ts`, `wrapper/src/server.ts` and `wrapper/test/proxy.test.ts`. Exclude the `PaymentError` import, payment option types, admission/voucher routes and payment error handling until 10. | 8 |
| 10 | `wrapper: authenticate paid reads and recover settlements` | `wrapper/src/payment.ts`, `wrapper/src/payment-chain.ts`, payment portions of `wrapper/src/proxy.ts`, `wrapper/test/payment.test.ts` and payment dependencies. The journal already exists in 8. Keep the controller and proxy changes together because the proxy imports `PaymentError` and these tests exercise admission through the proxy. | 1, 5, 8–9 |
| 11 | `wrapper: package operator and personal onion services` | `wrapper/src/main.ts`, `wrapper/src/setup.ts`, Dockerfiles/build-context allowlists, compose files, `wrapper/torrc`, startup/setup scripts and the matching operator runbook sections. Add live-test commands with their runners in 19. | 8–10 |
| 12 | `provider: bound light-client startup and cancel abandoned work` | Startup/failover/cancellation portions of `provider/src/light-client/header-source.ts`, `provider/src/light-client/polling-transport.ts`, their tests, `provider/test/light-client/startup-failover.test.ts`, `provider/test/light-client/lodestar-lifecycle.test.ts` and the Lodestar patch. Include the matching patch hash in the lockfile. Keep local-execution context fields for 13. | Existing provider |
| 13 | `provider: execute bounded calls against authenticated state` | `provider/src/execution/`, `provider/test/execution/`, authenticated execution-context fields/mapping in `provider/src/light-client/header-source.ts` and matching fixture updates; EVM dependencies and execution exports. | 12 |
| 14 | `provider: validate onion identities and discover ENS operators` | `provider/src/operators/`, `provider/src/discovery/`, their tests and discovery exports. Include required operator/payment metadata fields in `provider/src/api/derpc.ts`; defer runtime API wiring until 15. Any transport header/redirect support used by discovery belongs here with its request-option types. | 3, 13 |
| 15 | `provider: integrate discovery payments and request cancellation` | Remaining public API/exports, EIP-1193 opt-in, pool/pooled-reader lifecycle, request-header and transport wiring, `provider/test/api/extensions.test.ts`, `provider/test/api/execution-budget.test.ts`, pool lifecycle tests and provider guide. Include personal-credential cleanup with its regression from the start. | 5, 12–14 |
| 16 | `frontend: expose ENS personal nodes and test payments` | `frontend/src/payment-panel.ts`, `frontend/src/wallet-payments.ts`, their tests, and related main module, HTML, CSS, package and main-test changes. Keep unrelated directory/site-build work out. | 15 |
| 17 | `payments: support sponsored reads through paid wrappers` | `payments/src/sponsored.ts`, `payments/src/sponsored-client.ts`, `payments/src/coordinator.ts`, coordinator exports, sponsored intent/state additions, coordinator/sponsored tests and `payments/examples/`. Keep the evidence verifier with these examples: it consumes provider types and execution support. | 7, 13, 15 |
| 18 | `test: verify escrow wrapper and sponsored payment lifecycles` | `contracts/test/payment-adversarial.test.mjs`, `contracts/test/wrapper-payment.test.mjs` and `contracts/test/sponsored-payment.test.mjs`. These are cross-package integration tests; feature-specific tests already accompany the relevant implementation. | 1, 8, 10, 15, 17 |
| 19 | `wrapper: record onion container and restoration checks` | `wrapper/test/live-browser.mjs`, `wrapper/test/paid-container.mjs`, `wrapper/test/backup-restore.mjs`, `wrapper/test/personal-ui.mjs`, their sanitized evidence, matching package scripts and reproduction instructions. | 11, 15–18 |
| 20 | `docs: reconcile implementation evidence and release gates` | Remaining task-specific README/provider/operator/contract-guide updates, `specs/CONTEXT.md`, `specs/ROADMAP.md`, `specs/OPERATIONS.md` and AI attribution. Layout additions accompany the commits that introduce their folders; only remaining reconciliation belongs here. Preserve prior planning transcripts verbatim and keep the separate site documentation out. | Earlier implementation commits |

### Shared files that must not be staged wholesale

- **Workspace and lockfile:** register each package with its first implementation. Add only its dependencies/importer changes, and regenerate/check the lockfile against that commit's manifests. Do not put the whole current lockfile in commit 1: it also contains the directory frontend, EVM and later payment integrations.
- **Package exports and scripts:** `payments/src/index.ts`, the Node re-exports, `provider/src/index.ts` and package manifests must reference only modules present in that commit. The final Node store re-exports coordinator functions; those exports belong in 17, not 7.
- **Mixed tests:** `contracts/test/contracts.test.mjs` has escrow and registrar setup/cases; split both setup and tests between 1 and 3. Keep all of `payments/test/adversarial.test.ts` in 6 because it imports both payment implementations.
- **Wrapper proxy:** the current `proxy.ts` imports `PaymentError` at runtime. Staging that whole file in 9 without `payment.ts` creates a broken commit. Its payment-specific hunks move together in 10. Likewise, `main.ts` dynamically imports settlement modules, so it arrives with packaging after those modules exist.
- **Provider:** split header initialization from execution-context support between 12 and 13. Discovery imports the `DeRPCOperator` type, so its metadata fields must already exist in 14. Keep final provider API wiring and its broad integration tests together in 15.
- **Runbooks and layout:** package-specific instructions accompany the corresponding runnable feature. Add each folder's `REPO_LAYOUT.md` entry when that folder first enters history. Reserve claims about combined evidence and remaining external gates for 20.

### The two review fixes

The payment-client correction and its two regression cases belong in **5**. The journal shutdown correction and its two regression cases belong in **8**, separate from controller/settlement behavior in **10**. This supersedes the earlier two fix-only patches: those patches isolate the review delta, but are not a complete series from the current Git HEAD. If another contributor commits the base packages before this series is prepared, reassess the diff and use the original fix-plus-test pairs as follow-up commits instead. Never split a regression from its fix or revert correct code just to recreate a historical bug.

The review established red/green results for all four regression cases. It also ran the payment and wrapper suites, the local wrapper/escrow integration and both package type checks. Those results validate the combined working tree at the time of the review; they do **not** establish that every proposed intermediate commit builds.

Before recording each commit, inspect its staged diff and validate that isolated snapshot with its package type check and relevant tests. Contract checks require a local EVM; store/HTTP checks require working `flock` and loopback sockets. Finish with workspace type checking and the combined test/build gates. Stage and record the commits through the team's normal workflow; this plan itself does not change Git history.
