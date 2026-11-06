# M1 — ENS-managed private RPC operators

Status: **implemented and tested locally; public milestone incomplete**. Requested by the team on Nov 6, 2026. This milestone implements the ENS/Tor part of [DEMO_WORKFLOW.md](DEMO_WORKFLOW.md) while keeping the free-first delivery decision in [CONTEXT.md](CONTEXT.md).

## Outcome

A user chooses real operator ENS names. DeRPC discovers and proves their endpoint records through Anon-RPC, connects to the authorized onion services, and verifies supported mainnet reads locally. Operators can rotate endpoints using restricted ENS permissions. After a finalized update and a successful directory refresh, the client adopts replacements and stops using delisted operators.

**Pitch:** an ENSv2-managed RPC network where clients discover operators anonymously and independently verify both endpoint records and RPC answers.

ENS-to-onion naming already exists; that alone is not the novelty claim. The intended distinction is the complete, demonstrated combination of ENSv2 operator management, anonymous discovery, authenticated records and verified responses. No claim of being the first is required.

The [official ENS Mumbai criteria](https://ethglobal.com/events/mumbai/prizes/ens) specifically call for meaningful ENSv2 usage, functional rather than hard-coded behavior, a live demo and accessible open-source code. Scoped update permissions, dedicated resolvers and listing lifecycle changes must visibly affect DeRPC's behavior.

## Scope and delivery checkpoints

| Checkpoint | Required demonstration | Status |
|---|---|---|
| **M1-A: verified operator lifecycle** | Two independent operators, one onion endpoint each; proven discovery; restricted endpoint rotation; explicit finalized refresh; registrar delisting; proof rejection and fail-closed behavior | Remaining integration and public deployment |
| **M1-B: distributed endpoints** | At least one of those operator names authorizes two live endpoints; endpoint-level health and failover, unchanged operator selection weight, endpoint rotation and operator-wide delisting | Code, interface and actual-code fork checks pass; public deployment pending |

M1 is complete only when **both checkpoints** pass. M1-A is a useful earlier demonstration, not permission to drop M1-B. Public independent-operator enrollment still waits for the details the team said it would supply; local fixtures or same-party proxies do not satisfy that gate.

The chain is Ethereum mainnet for ENS and verified reads. User reads are free, with no wallet connection or deposit. Registration/update transactions still require the authorized operators' wallets and mainnet gas. Staking, payments, slashing, permissionless enrollment, additional chains and query-content privacy remain outside this milestone. Preserve the existing payment implementation and Hoodi escrow for the later rollout.

## What already exists

Reuse the curated registrar and fixed proof layout, ENS deployment planner/receipt verifier, dedicated resolver permissions, anonymous discovery, local EVM verification of resolver calls, onion wrapper, identity matching, host proof verifier, local failover, and dashboard/onboarding draft. Existing fork and browser evidence is documented in [OPERATIONS.md](OPERATIONS.md).

The latest [QA report](QA_REPORT.md) records successful local-gateway reads and lifecycle checks, while the dated [all-onion check](../wrapper/test/onion-availability-evidence-2026-11-06.json) establishes one current-source local success. The public-gateway release gate remains open. The operator/endpoint model is being expanded under M1-B; public multi-endpoint acceptance still requires actual independent operators and ENS enrollment. No real operator ENS subregistry/registrations have been recorded as deployed in the project plan.

## Work packages, in priority order

| ID | Deliverable and concrete work | Acceptance gate | Dependencies / issue mapping |
|---|---|---|---|
| **M1.0** | Stabilize the anonymous path: diagnose onion timeouts, use a reliable public gateway, confirm fresh checkpoint and safe committee-period startup. Prepare a clean-browser test with payments off. | Supported reads and shutdown work through the actual wrapper/onion path, without direct execution/beacon RPC. Public browser route works from the intended host. | Existing release gates #13, #27, #49; unblocks live evidence |
| **M1.1** | Prepare real operators and ENS deployment: obtain public configuration, refresh parent/contract preflight, reuse the four-stage unsigned planner, verify roles/receipts/runtime and save the manifest. Build narrowly scoped update/delist plans if the existing planner does not express them. | Two independent operators have active subnames and dedicated resolvers; parent/subregistry/registrar pins and exact permissions are reviewable and receipts match the plans. | #44, #45, #47; operator input and wallet signatures |
| **M1.2** | Make proven discovery the required mode for this demonstration: prove registrar admission and the complete ENS path/records at one authenticated block; validate wrapper identity and a public proof fixture; preserve explicit operator choice. | `listVerification` and `recordVerification` are both proven. Tampered, off-chain, oversized or inconsistent records cannot become routable endpoints. No silent downgrade to unverified discovery. | #46–49, #52; can develop against fork fixtures before M1.1 is deployed |
| **M1.3** | Demonstrate restricted update and delisting: rotate an endpoint using only the allowed resolver text-key permission; refresh after finality; delist through the registrar and refresh again. | Same operator identity survives rotation; old endpoint health is cleared. Unauthorized role changes fail. Delisted operator stops receiving new work; another explicitly chosen operator remains usable. | M1.1–M1.2, #44–47, #52; completes M1-A with M1.0 |
| **M1.4** | Add multiple endpoints per operator: separate operator/endpoint IDs, define bounded plural records, extend planner/verifier/discovery and scoped roles, group pool selection, and connect onboarding drafts to valid deployment configuration. | One name serves through two independently keyed onion endpoints; endpoint failure does not multiply or remove the whole operator's identity. Operator weight is independent of endpoint count. Rotation/delisting affect the correct scope. | M1.2 API/schema agreement; new follow-up work under #45, #46, #49, #52, #53 and pool/UI work |
| **M1.5** | Present and package the evidence: show record source, verified block, identity match, selected node, local health, pending updates and delisting in the dashboard; publish the free site and document reproduction. | Fresh-browser run of both checkpoints; retained receipts and proof contexts; human-recorded demo; public source and current threat-model/limitations statement. | All preceding gates; #11 and existing dashboard work |

Issue numbers above are references to existing work, not claims those issues are closed. New subtasks should be added to the tracker when implementing; this document does not create a GitHub milestone or issues.

### M1.1 — identity, permissions and deployment inputs

For each operator collect its intended label, public operator address, dedicated resolver cold owner, distinct endpoint-update hot key, identity signer, public onion RPC and beacon URLs, capabilities, fixed lease expiry, and declared gateway ownership. Existing deployment tooling also requires a public payee address in the registrar layout even for a free listing; omit paid terms and payment activation. Obtain authorization to interrupt/rotate the operator's demo endpoints before those live tests.

Revalidate the `derpc.eth` owner and parent permissions with a fresh preflight. Do not assume an old observation remains current. Review complete transaction requests before the holders sign; record chain, sender, destination, calldata, role scope, gas estimate and expected state change. Preserve the current parent resolver and stop on unexpected ownership, role or contract conflicts.

Keep current registrar semantics: curated admission, short expiry, non-transferable token-owner roles, separate resolver administration. Its `remove(index, operator)` clears active admission; it **does not burn the ENS token**. After the November 6 review the curator can also reinstate a removed entry, and only the curator can renew a lease that has lapsed (see [contracts/README.md](../contracts/README.md#operatorregistrar)). Client eligibility must use the proven registrar flag as well as ENS ownership and expiry. The parent/curator's powers remain disclosed.

The hot key may change only the designated endpoint record on its own resolver. It must not change ownership, resolver administration, signer/payee records or another operator's records. Use the existing ENSv2 permission contracts; tests must demonstrate both an allowed update and denied actions. Negative transaction tests can use a real-code fork or call simulation; there is no need to spend public gas on deliberate failures.

### M1.2–M1.3 — discovery, rotation and lifecycle rules

- Bootstrap from a trusted checkpoint, pinned worker and an explicitly selected bootstrap operator. Fetch registry/list/record dependencies through the worker and verify them locally at one authenticated finalized mainnet block. Do not hide the bootstrap dependency or claim zero trust assumptions.
- A whole discovery refresh must either produce an authenticated snapshot or fail visibly. A record-read failure must not silently authorize a partial, unverified directory. A separately identified endpoint reachability failure is an availability observation, not an ENS ownership verdict.
- The demonstration permits public-fixture identity/proof probes during an explicit directory refresh. Do not send users' account queries to every discovered endpoint. Normal reads stay within the user's chosen operators.
- Record the snapshot block/hash and verification time. Do not display a submitted or merely mined update as effective in the finalized view. Make the pending-finality state visible and provide explicit refresh. Do not claim immediate global revocation.
- Define and test a bounded directory-snapshot validity period before release. Failed refreshes do not extend it. Within that bound, the last authenticated snapshot may remain clearly labeled with its age; beyond it, refresh is required before new work. Expiry is enforced at dispatch and completion boundaries even if no refresh occurs.
- After a newer verified snapshot authorizes rotation, update destinations while preserving the user's routing policy; cancel or reject obsolete in-flight work and invalidate old endpoint identity/health caches. Manual mode retains only previously selected operators. Under the team's subsequent explicit automatic-mode opt-in, new free operators may enter only after both membership and records are proven and the optional allowlist permits them; an empty allowlist permits none.
- After a verified delisting/expiry, no new read uses the removed identity. Use another already selected active operator or fail closed. Do not silently return to the bootstrap list. Preserve explicit private-node configuration separately from public ENS admission.
- Keep the existing legacy/unverified discovery modes separate if needed for compatibility; neither can satisfy the milestone's proven-discovery gate.

### M1.4 — bounded endpoint model

The agreed implementation schema is versioned JSON in `derpc.endpoints`:

```json
{"version":1,"endpoints":[{"id":"node-a","url":"https://rpc.example.org/","beaconUrl":"https://beacon.example.org/"}]}
```

The record contains 1–8 entries and at most **4096 UTF-8 bytes**. Both bounds apply. Only the shown fields are accepted; `beaconUrl` is optional unless the common capabilities require beacon service. Endpoint IDs contain 1–31 lowercase ASCII letters, digits or hyphens, starting and ending with a letter or digit. IDs and canonical RPC URLs must be unique within the operator. URLs must pass the HTTPS/v3-onion validator and contain no query string, credentials or fragment. Common signer, capabilities and gateway declarations remain separate operator records. The shared parser and serializer live in `provider/src/operators/endpoints.ts`.

A nonempty invalid plural record rejects the operator and never permits fallback to singular records. An empty/absent plural record permits the legacy `derpc.endpoint` and optional `derpc.beacon` format. Plural deployments clear those singular records; legacy deployments clear the plural record. The registrar's proven storage layout remains unchanged.

The runtime keeps a flat endpoint list with stable grouping: `operatorId` is the ENS name, `endpointId` is the published node ID, and the globally unique `id` is `<name>#<node-id>`. Legacy entries retain their existing global ID and omit `endpointId`. Selection and allowlists use the operator identity. Reusing a node ID with a different URL is a rotation: the old endpoint's observations and identity cache must not authorize the new destination. Every plural wrapper echoes its exact `endpointId` alongside the common ENS name and signer. This is reciprocal metadata matching, not a signature or ownership proof.

For the updated deployment, scope the hot key to the plural endpoint record and remove unnecessary legacy endpoint-write permissions. Update planner, receipt/role verifier, wrapper setup output and record documentation together. The onboarding draft is still untrusted input: convert it explicitly, enforcing the registrar's current 1–31-byte label constraint and all required role/expiry fields. A successful draft export is not deployment validation.

Choose among the user's selected **operators** first, then eligible endpoints of that operator. Retain per-account affinity, bounded retries and endpoint-local exclusion. Publishing more URLs must not increase an operator's selection weight. Multiple endpoints do not establish independent ownership. The dashboard groups endpoint observations under the operator and removes the entire group when admission expires or is revoked.

Free multi-endpoint reads are the scope. Plural records with payment terms, and wrappers configured with both an endpoint ID and payment settlement, are refused. Existing funded legacy sessions remain pinned to their original settlement endpoint; do not share payment sessions/journals across wrappers or silently enable paid multi-node routing.

## Parallel execution plan

After agreement on schema/API boundaries, these tracks can run concurrently:

| Track | File ownership / responsibility | Synchronization point |
|---|---|---|
| Network and wrapper | `wrapper/`, public gateway operation, actual onion availability evidence | Supplies working public endpoints and identity/setup output |
| ENS contracts/tooling | `contracts/` registrar/roles, planner, receipt verification and fork tests | Owns record schema deployment and permission migration |
| Provider | `provider/src/discovery/`, `operators/`, `pool/`, API and tests | Owns authenticated snapshot and operator/endpoint model; agrees types before UI integration |
| Dashboard/onboarding | `frontend/`, `web/` and interaction tests | Consumes agreed provider events and deployment-draft schema; does not infer verification |
| Integration/evidence | Test scenarios, release artifacts, operations/submission docs | Reconciles all tracks after tests; runs real clean-browser flow |

Avoid concurrent edits to shared types and the same tests; assign an owner before work starts. This is an execution plan, not authorization to substitute demo proxies, publish operator details, sign transactions or send messages to independent operators.

The critical path is: working anonymous transport + real operator inputs → deploy/verify ENS → prove discovery → finalized rotation/delisting → expanded multi-endpoint validation → public demonstration. Fork implementation and schema/UI work can proceed while public inputs are pending. Do not promise a completion date until the endpoint owners, signing windows and public gateway are available; chain finality and operator response time cannot be parallelized away. The hackathon submission deadline remains as recorded in [SUBMISSION.md](SUBMISSION.md).

## Acceptance scenario and evidence

Use two independent operators, A and B. M1-A starts with one endpoint each and a replacement ready for rotation. M1-B gives A two endpoints, with B available as an independently operated fallback. Never describe several wrappers on the team's machine as independent operators.

1. **Discover:** a clean browser bootstraps anonymously; the user refreshes the real registry. Show two real ENS names, proven admission/records, verified block and endpoint identity match.
2. **Read:** select A and B; complete a supported mainnet read and show the serving endpoint and authenticated result.
3. **Rotate:** use A's restricted key to change an endpoint record. Show the transaction receipt, the pending-finality boundary, and the verified new snapshot. A keeps its name; future reads use authorized current endpoints.
4. **Fail over:** in M1-B, interrupt one of A's agreed demo endpoints. Show recovery through A's second endpoint. Then make A unavailable and recover through already selected B. Measure the actual timings and failures.
5. **Delist:** the curator delists A using the registrar. After finality and verified refresh, A leaves the eligible pool even if its ENS token still exists. With only A selected, reads fail rather than selecting B automatically. Test expiry with controlled clocks and record a live expiry only if actually observed.
6. **Reject and stop:** an explicitly labeled corrupted response is rejected; cutting the anonymity transport refuses further reads. A forged directory/identity cannot redirect queries to an unapproved endpoint.

Retain public deployment/update/delist receipts, exact role tables, runtime/code pins, before/after directory snapshots with block contexts, bounded transport/event traces, focused test results, measured timings and the published demo URL. Redact tokens and private service addresses. Record source/build identity through the team's commit process; agents never stage or commit.

The human demo should fit the existing 2–3 minute video target. Record real actions and edit out waits with clear transaction/block transitions; do not speed up or imply mainnet finality happened instantly. A working lifecycle is the ENS-specific evidence; a token/staking mockup is not a substitute.

## Done checklist

- [ ] Two independent operators registered and permission/receipt evidence verified.
- [ ] ENS list and complete endpoint records proven through Anon-RPC at a single authenticated snapshot.
- [ ] Restricted endpoint update works; unrelated permissions remain denied.
- [ ] Finalized rotation, registrar delisting and bounded stale-snapshot behavior pass.
- [ ] One operator serves through at least two onion endpoints with correct attribution and unchanged operator weight.
- [ ] Endpoint and operator failover remain within explicit choices; expired/revoked endpoints do not receive new work.
- [ ] Clean public browser path, proof rejection and shutdown pass with payments off.
- [ ] Public demo, reproducible source, human recording and accurate trust/privacy limitations are available.

Passing local tests or M1-A alone does not complete M1. While registration inputs are deferred, report the code/fork checkpoint honestly and leave the public gates open.

## Implementation checkpoint, November 6

M1.2 now has a ten-minute proven-snapshot lifetime capped by the authenticated block's 30-minute maximum age, monotonic/rollback checks, same-block replay protection, cached/in-flight read guards and an explicit administrative recovery path. The dashboard displays the authenticated block, age and expiry and leaves restriction/stop/refresh controls usable. Incomplete execution or metadata transport failures abort the entire refresh; proven invalid records and endpoint availability observations are handled separately. Known gateway/RPC ownership conflicts are refused before probes.

M1.3 now has [unsigned lifecycle tooling](../contracts/README.md#ens-operator-lifecycle) for restricted endpoint rotation, renewal and registrar delisting. The [actual-code fork evidence](../contracts/deployments/ens-lifecycle-fork-evidence.json) covers permissions, expired-active renewal, unchanged token identity, canonical receipts, same-block interference and finality labels. The tool performs no public writes and never claims that its administrative receipt establishes a verified browser refresh.

M1.4 now has the shared plural schema, exact per-node identity checks, fair operator-first routing, endpoint-local health, sibling failover and authenticated owner/signer continuity across complete URL rotation. The dashboard groups nodes and compares imported lifecycle evidence with a fresh proven directory. The onboarding converter exports an unsigned operator fragment with explicit role/expiry fields. Plural deployment and lifecycle tools perform atomic cold-owner migration and complete-list hot-key rotation while preserving original deployment records and receipt provenance. [Local fork evidence](../contracts/deployments/ens-endpoints-fork-evidence.json) covers those transitions, permission denials, rollback, reorgs and delisting. The [operations checkpoint](OPERATIONS.md#multiple-endpoints-and-verified-ens-november-6) records 1004 default tests, five separate actual-code fork tests, type checking, interface checks and the combined build.

The [earlier current-source all-onion check](../wrapper/test/onion-availability-evidence-2026-11-06.json) passes through the team's existing local gateway and demo proxy with payments off. That advances local M1.0 evidence; it does not supply a reliable public gateway or independent operators. M1-A public deployment and finalized lifecycle demonstration, and M1-B enrollment of multiple live endpoints under actual independent names, remain open. No final checklist item above is marked complete solely by local checks.

The later [live sibling-onion check](../wrapper/test/multiendpoint-evidence-2026-11-06.json) establishes two ready test nodes, actual forced HTTP failure, sibling recovery and affinity, explicitly selected other-operator fallback, general ENS resolution and shutdown at authenticated block 26356914. It is a current-source, same-party mock-identity demonstration with disposable endpoints. Actual name enrollment, proven directory refresh and finalized public lifecycle changes remain separate acceptance steps.

## Original planning commit

The original plan was one documentation-only change: `specs: plan ENS-managed private RPC milestone`, covering this file and its cross-links in `CONTEXT.md`, `ROADMAP.md`, `DEMO_WORKFLOW.md`, `TRACKS.md`, `../REPO_LAYOUT.md` and `../AI_USAGE.md`. Subsequent implementation is split separately in [OPERATIONS.md](OPERATIONS.md#multiple-endpoints-and-verified-ens-november-6). Select related hunks from the shared dirty workspace; agents do not stage or commit.
