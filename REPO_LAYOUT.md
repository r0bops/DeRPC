# DeRPC repo layout

Every folder and top-level file, with a one-line note on each. Items marked *(planned)* don't exist yet. Update this file in the same change whenever a folder or top-level file is added, moved or removed.

## Top level

```
README.md          — project overview, provider quickstart, supported reads and release instructions
ARCHITECTURE.md    — request flow, host/worker verification boundaries, ENS authorization and optional payments
THREAT_MODEL.md    — browser, ENS, wrapper and payment trust boundaries, threats, controls, evidence and unresolved gates
FEEDBACK.md        — observed integration benefits, friction and partner suggestions for EF/ENS submission fields
AI_USAGE.md        — how AI tools were used
REPO_LAYOUT.md     — this file
LICENSE            — MIT
.gitignore         — excludes upstream clones, local agent instruction files, .env files and build output
.github/workflows/ci.yml — on pull requests and main: type check, tests, release build, offline release check and an IPFS package artifact
.github/workflows/release-ens.yml — manual release: package with the release gateway, pin on the team IPFS node, check public retrieval; sends no transaction
.github/actions/site-package/ — the build, check and packaging steps both workflows share
.github/actions/install-kubo/ — downloads the pinned Kubo release and verifies its recorded SHA-256
frontend/.env.example — VITE_TOR_GATEWAYS: our own tor-js gateway address(es); copy to .env.local
package.json       — workspace root: demo/directory dev and build scripts, combined build:site, and typecheck (pnpm)
pnpm-workspace.yaml — provider, frontend, web, wrapper, payments and contract packages, Lodestar/ssz pins and patch registration
pnpm-lock.yaml     — pinned dependency versions
patches/
└── @lodestar__light-client@1.43.0.patch — Lodestar finality/committee guards and terminal startup/synchronization cancellation
tsconfig.base.json — shared strict TypeScript settings
```

## /specs — design docs and plans

```
specs/
├── CONTEXT.md     — project brief and decisions (the source of truth)
├── ROADMAP.md     — execution order and completion gates
├── DEMO_WORKFLOW.md — operator dashboard, multi-endpoint onboarding and deferred staking/pricing requirements
├── ENS_TOR_MILESTONE.md — free ENS/onion milestone, scoped rotation/delisting demo and multi-endpoint completion gates
├── ANON_RPC.md    — notes on the upstream Anon-RPC spec, plus design findings
├── OPERATIONS.md  — implementation evidence, deployment commands and remaining external gates
├── QA_REPORT.md   — Nov 6 project-wide test results, reproduced defects and remaining release evidence
├── TRACKS.md      — prize tracks, judging criteria, qualification checklists
├── SUBMISSION.md  — ETHGlobal submission, video and AI rules
├── SUBMISSION_DRAFT.md — project and partner form text, timed human-narrated demo script and final handoff gates
└── prompts/       — AI conversations and prompts, kept verbatim
    ├── README.md                                   — what goes here, naming, required header
    ├── 2026-11-05-claude-planning-conversation.md  — architecture and security decisions
    ├── 2026-11-05-grok-planning-chat.md            — idea history and name (review before publishing)
    ├── 2026-11-06-consensus-theory-research-prompt.md — research prompt on agreement and fairness mechanisms (not run yet)
    ├── 2026-11-06-ens-use-cases-research-prompt.md — research prompt on ENS use cases for the pool (not run yet)
    ├── 2026-11-06-low-resource-node-research-prompt.md — research prompt on the smallest node that can back an operator (not run yet)
    ├── 2026-11-06-operator-wrapper-research-prompt.md — research prompt on an operator-side wrapper (not run yet)
    ├── 2026-11-06-payments-research-prompt.md — research prompt on paying operators per query (not run yet)
    └── 2026-11-06-simple-payments-research-prompt.md — research prompt on the simplest per-query payment (not run yet)
```

## /provider — the DeRPC library

```
provider/
├── package.json                      — @derpc/provider (private); harness, Lodestar 1.43.0, noble hashes, buffer polyfill; viem as an optional peer (for `./viem`); vitest
├── README.md                         — the integrator API: supported methods, block rule, initialization, routing, cancellation, errors
├── tsconfig.json
├── stubs/lodestar-spec-test-util/    — empty stand-in for a broken-on-npm Lodestar dependency (see its package.json)
├── src/
│   ├── index.ts                      — public exports; imports the browser globals first
│   ├── api/
│   │   ├── derpc.ts                  — createDeRPC: boots the worker and light client, holds the user's operators, proves the pin, serves reads; simulatedLyingOperator
│   │   ├── directory-snapshot.ts     — bounded proven-directory authorization lifetime, monotonic expiry and status
│   │   ├── eip1193.ts                — the EIP-1193 provider: proven methods only, the finalized-block rule, error codes
│   │   └── viem.ts                   — derpcTransport for viem (`@derpc/provider/viem`), with viem's retries off
│   ├── runtime/node-globals.ts       — minimal `process` and a Buffer polyfill for browsers (Lodestar assumes Node)
│   ├── operators/                    — HTTPS/v3 onion validation, reciprocal wrapper identity and gateway separation; bounded plural-record schema in endpoints.ts
│   ├── discovery/                    — ENSv2 record discovery, proven registrar list/payee, and user-choice reconciliation
│   ├── execution/                    — bounded local EVM calls using authenticated proofs; general on-chain ENS resolution via the optional ./ens export
│   ├── config/mainnet.ts             — pinned worker specifiers (tor-js, Nym), gateway, light-client checkpoint, endpoints, operators with mock ENS names
│   ├── transport/
│   │   ├── pinned-bootstrap.ts       — answers the harness's two specifier calls from the pin; refuses all else
│   │   ├── anon-transport.ts         — one long-lived worker; fetch with timeouts and isolation keys; no direct fallback
│   │   ├── fetch-adapter.ts          — presents the transport as a standard fetch for the light client
│   │   ├── json-rpc.ts               — JSON-RPC to one execution endpoint through the transport
│   │   └── response-body.ts          — shared stream reader: one request deadline, cancellation, and 16 MiB body cap
│   ├── light-client/
│   │   ├── polling-transport.ts      — light-client transport that polls instead of opening the beacon event stream
│   │   └── header-source.ts          — pinned checkpoint in, verified fresh finalized execution header out
│   ├── verify/
│   │   ├── hex.ts, rlp.ts            — strict hex and RLP decoding
│   │   ├── mpt.ts                    — Merkle-Patricia proof walk (values, absence proofs; rejects incomplete or padded proofs)
│   │   ├── index.ts                  — EIP-1186 account, storage and code verification against a state root
│   │   ├── reader.ts                 — verified reads at the verified block: balance, nonce, code, storage, token balance
│   │   └── worker-pin.ts             — proves the specifier's workerHash (slot 1) equals the pin; gates reads on it
│   └── pool/
│       ├── pool.ts                   — manual or explicit automatic selection using local outcomes; sticky accounts, exclusion, cooldowns, bounded fresh-circuit retries and events
│       └── pooled-reader.ts          — verified reads through the pool, cached per verified block
└── test/
    ├── fixtures/                     — recorded mainnet/Hoodi beacon responses, mainnet proofs and worker-pin proof; actual ENS execution proof pack, recorder scripts and dated public-roster evidence
    ├── helpers/fixture-fetch.ts      — serves recorded beacon responses by path
    ├── helpers/recorded-endpoint.ts  — an execution endpoint that answers only the recorded mainnet proofs
    ├── api/                          — the EIP-1193 provider (methods, block rule, refusals, error codes), viem on top, and the DeRPC wiring (no choice → no reads, pin check, fail closed)
    ├── operators/                    — onion URL integrity, identity rotation/mismatch and gateway separation
    ├── discovery/                    — ENS responses, expiry, off-chain refusal and registrar storage proofs
    ├── execution/                    — proof-backed execution, tampering, context and work-limit tests
    ├── light-client/                 — #9419 attack, committee authenticity, polling/header checks and a manual Firefox committee-boundary harness
    ├── verify/                       — proof verification (tampering, binding, absence, truncation), the reader, the worker-pin check
    ├── pool/                         — manual/automatic policy, local observations, exclusion, cooldown, retries, bounds, sticky accounts and pooled reads
    └── transport/                    — fetch adapter, JSON-RPC sender, fail-closed transport
```

## /frontend — the demo pages

```
frontend/
├── package.json        — Vite 8.3.5, TypeScript 5.9.3, viem 2.57.8, self-hosted Inter
├── vite.config.ts      — relative asset paths, public-gateway release checks, three pages and dev-only call logging
├── build/gateways.ts   — gateway address validation and release-output scanning
├── test/              — safe rendering, ENS/payment controls, wallet chain binding, release gateways, Firefox cache/private-window HTTP evidence and opt-in public VPS/IPFS-path and live ENS-domain verification; ipns-hosted-firefox-evidence-2026-11-06.json records the post-IPNS activation run and preceding canceled-asset attempt
├── index.html          — the demo: start-up status, operator choice, verified reads, live operators, direct connections
├── example.html        — the smallest integrator example
├── network-check.html  — diagnostics for the anonymous path: Tor exits, proofs from every endpoint, beacon data
└── src/
    ├── main.ts           — the demo, on the public API only (createDeRPC + viem); the user picks operators (saved on the device); lying-operator and cut-network controls; dev-only `?fault=bad-worker-hash` and `__derpc` handle
    ├── operator-dashboard.ts — local endpoint observations, ENS provenance, conservative latency and stale/unknown health states
    ├── operator-groups.ts — stable operator grouping for selection, counts and endpoint rows
    ├── routing-preferences.ts — manual/automatic category, allowlist semantics and source-aware saved preferences
    ├── directory-freshness.ts — snapshot age/expiry presentation and dependent-read control state
    ├── direct-connections.ts — bounded ResourceTiming observations, coverage/empty states and observer lifecycle
    ├── ens-lifecycle-status.ts — bounded local receipt-evidence import and comparison with proven current ENS state
    ├── payment-panel.ts  — optional test-payment UI, deployment terms, session and refund states
    ├── wallet-payments.ts — wallet chain binding, deposit reconciliation and escrow actions
    ├── example.ts        — a viem client on derpcTransport: one proven read, one refused eth_call
    ├── network-check.ts  — the P1 checks, on the low-level transport on purpose
    └── style.css         — the product site's theme for these pages: imports web/src/tokens.css and follows docs/design-system.md
```

## /web — public directory and product pages

```
web/
├── README.md           — local development and combined release instructions
├── deployment-mainnet-alpha-2026-11-06.json — historical static deployment and browser evidence, marked removed after the ENS/IPFS hosting decision
├── deployment-ens-ipfs-2026-11-06.json — published IPFS release, asset/CAR checks, ENS transaction and public HTTPS browser evidence
├── deployment-ipns-2026-11-06.json — stable IPNS name, public signed record, independent resolution, encrypted-backup restore evidence and ENS activation status
├── ens-ipns-publication-2026-11-06.json — owner-signed IPNS switch, two-source receipt/record checks, HTTPS asset hashes and browser evidence
├── deployment-vps-2026-11-06.json — gateway/IPFS services, binary hashes, restart checks and fresh-node public IPFS retrieval evidence
├── ens-website-transaction-2026-11-06.json — unsigned mainnet contenthash update, decoded fields, two-source simulation and current resolver authorities
├── ens-website-publication-2026-11-06.json — canonical owner transaction, matching HTTPS assets and actual ENS-domain browser verification
├── ens-website-link-audit-2026-11-06.json — resolver creation-to-current event audit and direct record-bundle links before the website update
├── package.json        — Vite, TypeScript, Viem address validation and self-hosted Inter
├── index.html          — application entry point
├── tsconfig.json
├── vite.config.ts      — relative paths; serves/copies assets from /brand
├── public/favicon.svg
└── src/
    ├── main.ts, page.ts — hash routing and page interface
    ├── ui.ts           — shared navigation, live-demo link and finalized-read example
    ├── styles.css, tokens.css — site styles and design tokens
    ├── directory/      — network/operator data, validation, local multi-node onboarding drafts, unsigned operator-config conversion and directory styles
    └── pages/          — landing, directory, network, operator, operate and not-found views
```

`web/dist/` is generated and ignored. `pnpm build:site` places the release demo in `web/dist/demo/`.
`web/out/` is also generated and ignored; it holds the checked static copy, IPFS CAR and archive for the ENS/IPFS release.

## /brand and /docs — brand assets and design reference

```
brand/                 — logo, lockup and app-icon SVG/PNG assets
docs/
├── design-system.md   — site typography, colors, components and layouts
├── tracks.md          — prize-track alignment notes; specs/TRACKS.md holds the detailed requirements
└── assets/
    ├── *.png          — design-system and logo overview images
    └── screens/       — desktop and mobile page reference screenshots
```

## /contracts — prepaid escrow and ENS registrar

```
contracts/
├── package.json                 — Solidity 0.8.30 compilation and local Ganache/Viem/Vitest tests
├── README.md                    — contract trust, layout, roles and deployment workflow
├── src/
│   ├── QueryEscrow.sol          — immutable native-asset prepaid sessions, typed vouchers, close/refund/top-up
│   └── OperatorRegistrar.sol    — free curated ENSv2 registration, expiry/delisting, provable list and payee
├── scripts/                     — compilation, unsigned deployment and ENS rotation/renewal/delisting plans, receipt verification and local wallet review helpers
├── deployments/                 — templates, public ENS preflights, local lifecycle/fork/gas evidence, verified Hoodi escrow manifest and RPC cross-check
└── test/                        — escrow replay/refund/authorization, registrar role/layout and actual-code ENS lifecycle checks
```

## /wrapper — operator onion service

```
wrapper/
├── package.json, tsconfig.json — Node 24 TypeScript proxy, setup and test commands
├── README.md                  — node configuration, setup, personal mode and key backup
├── Dockerfile, Dockerfile.tor — separate proxy and Tor images, with no embedded keys
├── Dockerfile.dockerignore, Dockerfile.tor.dockerignore — allowlisted build contexts excluding secrets and local noise
├── compose.yaml               — loopback node APIs and persistent onion keys; no gateway
├── compose.personal.yaml      — optional token secret for the unpublished personal listener
├── compose.payments.yaml      — settlement-key secret and persistent payment-state volume
├── torrc                      — pool/personal onion services; proof-of-work disabled
├── src/
│   ├── proxy.ts                — body-aware RPC/beacon allowlists, budgets and finalized cache
│   ├── server.ts, main.ts      — loopback HTTP listeners and environment configuration
│   ├── payment.ts             — authenticated read credit and voucher/settlement lifecycle
│   ├── payment-store.ts       — bounded durable single-writer payment journal
│   ├── payment-chain.ts       — pinned escrow checks and prepared-transaction recovery
│   └── setup.ts                — starts compose, checks finalized proofs/beacon, prints ENS records
└── test/                      — filtering/payment/setup tests, real onion/browser and availability diagnostics, multi-endpoint packaging and sibling failover, paid container and encrypted restoration runners, labeled evidence
```

## /payments — host-side session protocol

```
payments/
├── package.json, tsconfig.json — shared Viem typed-data protocol and client package
├── src/
│   ├── protocol.ts             — escrow ABI and separate read, voucher and close authorization domains
│   ├── client.ts               — ephemeral session keys, post-verification totals, concurrency and spending limits
│   ├── delegation.ts           — capped app/user delegation and revocation
│   ├── sponsored.ts, sponsored-client.ts — delegated read intents, durable exposure and independently verified completion
│   ├── node-store.ts, node-worker.ts, node-codec.ts — Linux lock-holder process and durable delegation state
│   ├── coordinator.ts          — bounded loopback app signing service; trusted verifier required
│   └── index.ts                — public payment API
├── examples/                  — Linux coordinator, injected-transport sponsored reader, proof verifier and runnable entry points
└── test/                      — replay, budgets, parallel reads, failover, crash/restart and persistence helpers
```

## /demo — recording materials (planned)

```
demo/              — (planned) demo runbook and lying-node fixtures
```

## /scripts — helpers

```
scripts/
├── dev-services.sh   — starts/reuses the local tor-js-gateway and Vite dev server
├── show-logs.sh      — follows the dev call log and gateway log
├── assemble-site.mjs — copies the release demo into web/dist/demo after both builds pass
├── check-release.mjs — offline assembled-site checks for checkpoint/gateway inputs, page assets and accidental local files
├── package-ipfs.mjs — offline IPFS packaging of web/dist: CAR, root CID, ENSIP-7 contenthash and a per-file SHA-256 manifest in web/out/ipfs-release/
├── verify-ipfs.mjs  — compares a pinned release with its manifest: through public gateways, from a directory fetched from the pinning node, or by provider listing
└── vps/             — initial Ubuntu/systemd installation, bounded gateway/IPFS service units and public gateway configuration template; IPNS.md covers the dedicated website key, renewal and encrypted recovery; identities and backups stay outside the repo; pin-car.sh is the forced command for the release deploy key (accepts one CAR and its root CID)
```

## /reference — upstream context (not committed)

```
reference/
├── anon-rpc/      — read-only shallow clone of ethereum/anon-rpc (gitignored, never edited)
└── tor-js/        — ethereum/tor-js at v0.4.4 (gitignored); we build `tor-js-gateway` from it, never edit it
```
