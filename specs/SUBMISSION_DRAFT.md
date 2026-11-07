# Submission packet

Prepared November 6, 2026 for team review. This file does not submit anything or claim the external gates have passed. The event rules are in [SUBMISSION.md](SUBMISSION.md), partner criteria in [TRACKS.md](TRACKS.md), and current release evidence in [OPERATIONS.md](OPERATIONS.md).

## Project form

**Title:** DeRPC

**Tagline:** Private Ethereum reads, verified on your device.

**Repository:** https://github.com/r0bops/DeRPC

**Live demo:** [derpc.eth.limo/demo/](https://derpc.eth.limo/demo/) — [release `d90cc742`](https://github.com/r0bops/DeRPC/actions/runs/42314676419) published the integrated provider fixes. The [November 7 QA](QA_REPORT.md#pending-issue-continuation--november-7) found the published simulated-liar control skipped rejection after warmed reads and the directory loaded external operator favicons. Release the local fixes and repeat the exact-artifact rehearsal before recording. Later ENS/UI working-tree changes are separate from that deployment. **Video:** insert the human-narrated recording URL after upload. A local gateway recording must be labelled as such.

**Description:**

Ethereum apps usually reveal their users' IP addresses to RPC providers and accept the returned data on trust. DeRPC combines anonymous routing with verification on the user's device. Its browser provider sends execution and consensus requests through Anon-RPC and Tor, authenticates finalized Ethereum state with a light client, and checks balance, nonce, code and storage proofs in the host. If a response fails verification, DeRPC rejects it and can try another authorized operator anonymously. If the private network stops, reads fail closed.

The demonstration exposes those guarantees: choose operators, inspect the verified block and local health observations, inject a simulated corrupt answer, watch rejection and failover, and stop the anonymous network. An EIP-1193 interface and viem transport let browser apps use the same provider. Explicit automatic routing modes use local observations; the default preserves manual choice.

The repository also contains an onion-service wrapper, ENSv2 registrar and proof-backed discovery, bounded local EVM execution, and an optional test-payment implementation. The free demo uses clearly labelled public bootstrap providers. Two deployed team proxies have separate operator registration preparations; pending entries are not presented as proven ENS members. Public ENS lifecycle and paid-read deployment evidence remain separate gates; payments and staking are not prerequisites for free reads.

**How it is made:**

DeRPC supplies the pool, authorization and cancellation rules, proof verifier, worker-pin gate, provider adapters, ENS discovery, wrapper, contracts and demonstration. It reuses the Anon-RPC browser harness, tor-js, Lodestar, viem, EthereumJS EVM, Vite and their transitive dependencies. The workspace lockfile records versions. The pinned Lodestar patch fixes finality handling and shutdown behavior and disables forced committee updates. Verification stays in the host because worker code is untrusted.

**Challenges and learning:**

Private transport alone does not establish correctness, and a valid proof is useful only if its state root is authenticated. We joined the transport and light-client paths, eliminated a direct beacon event stream, proved the pinned worker hash after startup, and enforced freshness and authorization again when asynchronous work completes. ENS and payments introduced further boundaries: finality is different from receipt inclusion, endpoint redundancy is different from operator independence, and a voucher must follow successful verification.

**What is next:**

The integrated provider and deployment-verification fixes are published; retain a complete hosted regression tied to the exact release used in the recording. Publish and validate later working-tree changes separately, complete real ENS operator onboarding with team-run demo entries labelled honestly, and gather feedback from a wallet integrator. Independent-operator ownership and finalized directory lifecycle demonstrations remain gates. Paid deployment follows the free release. Broader methods, additional chains and a server anonymity runtime each require their own verification and runtime evidence.

## Partner form text

**Ethereum Foundation — Anon-RPC / CROPS:**

We integrate the Anon-RPC browser harness and pinned tor-js worker as the default route for all execution and beacon reads. A host-side light client authenticates finalized state; our host verifier checks account/storage proofs and code before returning results. Local bootstrap pins avoid direct bootstrap RPC, and a later proof checks the worker hash on-chain. The demo rejects a simulated corrupt response, retries anonymously within the authorized pool and refuses reads after transport shutdown. Page assets, bundle delivery, gateway setup and optional wallet/payment administration are disclosed separately in the README traffic table. MIT licensing, a static build and explicit trust limits support the CROPS story.

Feedback: the common fetch interface and host/worker separation worked well. More structured bootstrap/onion diagnostics, a gateway-hosted bundle integration example and isolation interoperability tests would help. Detailed observations are in [FEEDBACK.md](../FEEDBACK.md).

**ENS — use only after its live gates pass:**

DeRPC uses ENSv2 to manage curated, expiring operator identities with dedicated resolvers and restricted endpoint-update keys. The client fetches membership and records anonymously and authenticates them against finalized Ethereum state. Lifecycle tooling checks provenance, roles, canonical receipts and the difference between delisting and token ownership. Multiple endpoints are grouped under one operator identity so publishing extra URLs does not increase selection weight. Attach the real deployment, independent operator records and finalized rotation/delisting demonstration before using this text as a completed-integration claim.

Feedback: role separation and hierarchical registries fit this workflow. An authenticated-enumeration example and complete deployment/negative-role fixtures would reduce integration ambiguity. Local fork evidence alone does not satisfy the live-demo requirement.

## Recording runbook: 2 minutes 45 seconds

Record the browser at 1280×720 or higher with a human voice. Use the free path with no wallet prompts. Do not speed up the footage. Cuts around waiting are acceptable under the recorded event guidance; show the real startup duration and do not disguise a failed run. The timing below is a recording target, not a promised network latency.

Before recording, choose **Manual** routing, select two working bootstrap providers, press **Apply routing** and rehearse all three read/failure steps on the exact build. Saved automatic routing disables the simulated-liar control. Keep bootstrap and ENS-enrollment status labels visible. Have the tested local evidence available as an explicitly labeled backup if public infrastructure fails. Do not silently switch a public demonstration to a local gateway.

| Time | Action | Suggested narration |
| --- | --- | --- |
| 0:00–0:20 | Show the title and browser demo. | “An RPC provider can see who is asking and can return a false answer. DeRPC sends Ethereum reads through Tor and verifies supported answers on your device. This is a free, finalized-state read provider for browser apps.” |
| 0:20–0:45 | Show startup, the verified finalized block and worker pin; select two providers and press **Apply routing** if needed. | “The anonymous worker carries both execution and consensus requests. A light client in the host authenticates this finalized block. Before account reads, we also prove that the worker hash matches our pin. These are public bootstrap providers; the team proxies' separate ENS registrations remain pending.” |
| 0:45–1:15 | Show ETH balance, known WETH storage balance and bytecode with the verified block. Press **Read again**. | “These values come from proofs checked against the authenticated state root. The worker and RPC endpoint are not trusted to decide what is true. The dashboard shows observations from this device, not a global honesty score. Applications can use the same provider through EIP-1193 or viem.” |
| 1:15–1:50 | Press **Inject a lying operator (simulated)**. Open read events and show rejection, exclusion and honest failover. | “This control deliberately corrupts a real returned response. It is a simulation, not an accusation against a public operator. The host rejects the bad answer and excludes that endpoint locally. An authorized endpoint supplies a proof that verifies, still through Tor. Agreement between providers is not our evidence; the proof is.” |
| 1:50–2:15 | Press **Cut the anonymous network**. It automatically runs the refusal demonstration and disables further reads. Show the errors. | “Now we stop the private transport. Reads fail. DeRPC never repairs this by sending the query directly. That failure behavior is part of the product.” |
| 2:15–2:45 | Show the source/architecture and briefly return to the dashboard. | “Nodes still see query content; Tor hides the client's network address along this route. The checkpoint, host code and verifier remain trust assumptions. We support finalized proven reads, not general transaction RPC. The next release gates are sustained public availability and real ENS operator lifecycle evidence; team-run entries are not independent operators. Payments stay off for this free demo.” |

If the ENS gates pass before recording, replace part of the final segment with a short real directory update; do not squeeze an unobserved finality wait into the video. Keep separate transaction and verified-snapshot evidence, and remain below the CROPS three-minute cap.

## Finalist Q&A

- **Why several operators?** Availability and user choice. Proofs provide correctness; extra URLs owned by one party only add redundancy.
- **How do you detect a bad actor?** A failed proof rejects that response and excludes its endpoint locally. Timeouts establish an availability failure. Neither observation proves global malicious intent or supports automatic slashing.
- **Why finalized state?** The provider returns the block its light client has authenticated. It refuses `latest` rather than relabeling older finalized data as current. This is not a general low-latency trading or historical indexing backend.
- **What if an operator is removed?** Clients stop authorizing it after observing a finalized, verified directory refresh, or when their bounded snapshot expires. A submitted transaction is not immediate revocation on every client.
- **What if Tor stops?** Reads fail closed. The user must restore an anonymous route; there is no direct RPC fallback.
- **What remains trusted?** The checkpoint source, application/verifier code, Ethereum consensus assumptions and curated admission policy. Worker pinning identifies code; it does not prove anonymity or honest behavior.
- **What is live?** Use the dated evidence ledger and exact release identity. The ENS/IPNS website and integrated fixes are published through the checked release workflow; later working-tree ENS/UI changes are not included merely because a previous deployment passed. The three team-run proxies are deployed, but operator ENS registration remains unsigned. The sibling-onion tests used a local gateway and same-party demo proxies. The Hoodi escrow is deployed, but that is not a public paid-session demonstration. Do not describe fork tests as mainnet writes.

## Team completion checklist

- [x] Publish the recorded release and retain a [fresh Firefox pass after the ENS-to-IPNS switch](../frontend/test/ipns-hosted-firefox-evidence-2026-11-06.json) plus [55 matching HTTPS assets](../web/ens-ipns-publication-2026-11-06.json).
- [x] Publish the reviewed integrated provider and deployment-verification fixes. [Release d90cc742](https://github.com/r0bops/DeRPC/actions/runs/42314676419) passed the automatic publication checks; subsequent working-tree changes remain separate.
- [ ] Repeat hosted read/rejection/failover/shutdown checks against the exact artifact selected for final recording, and retain its source/CID binding.
- [x] Record a cold start after the period-1904 boundary, **November 6 at 19:53:59 UTC**, with forced updates disabled. The [19:54 run](../provider/test/light-client/period-1904-evidence-2026-11-06.json) and [21:51 integrated-provider run through the public gateway](../provider/test/light-client/period-1904-integration-evidence-2026-11-06.json) passed; both used local page delivery, so neither proves the newer release artifact is hosted.
- [ ] Record/upload a 2–3 minute human-narrated video and insert its URL plus the tested demo URL in the form.
- [ ] Review per-file AI attribution and identify meaningful human contributions from the team's actual work. Do not fabricate authorship or edit archived conversation bodies.
- [x] Review the Grok planning transcript for sensitive work context. The [read-only review](QA_REPORT.md#publication-review) is complete; its body and header remain verbatim.
- [ ] Decide whether the flagged private conversation links and work/project context can be published, following the prompt archive's rules. Preparing this packet does not make that decision.
- [ ] Choose EF; choose ENS only with its required live integration evidence. Fill partner feedback fields using the text above and the measured outcome.
- [ ] Submit through the Hacker Dashboard by **November 7 at 09:00 IST / 03:30 UTC**. No submission has been made by preparing this packet.
