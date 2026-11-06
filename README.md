# DeRPC

**A decentralized RPC pool for Ethereum, in development.** The browser demo routes reads through [Anon-RPC](https://github.com/ethereum/anon-rpc), checks account, storage and code proofs against a light client, and switches endpoints after a failed read. There is no direct RPC fallback.

Built at ETHGlobal Mumbai, Nov 5–7, 2026. This is a work in progress; the status below is as of Nov 6.

> You don't need to trust operators for correctness; you only need to limit what they can learn about you.

## The idea

### The problem

- A few large RPC providers see who is asking (the IP address) and what they ask.
- Wallets trust whatever the RPC returns, so a lying node goes unnoticed.
- Anon-RPC fixes the first point (who is asking), but not the second (whether the answer is true).

### What DeRPC does

DeRPC is a client-side provider that runs on the user's device. It wraps an Anon-RPC worker rather than replacing it:

1. **Anonymous transport.** Every RPC and beacon request goes through a sandboxed tor-js worker, so the endpoint sees a Tor exit instead of the user's IP. A Nym pin is configured, but its runtime has not been validated here.
2. **Verification in the host.** The worker is untrusted code, so verification lives outside it. A sync-committee light client, started from a pinned checkpoint, gives a verified state root. Each `eth_getProof` (EIP-1186) answer is checked against that root.
3. **Local endpoint selection.** Pick a public keyless endpoint, exclude it locally if its proof fails, and retry another through the worker. Selection is random within preferred and fallback tiers; transient failures put an endpoint on cooldown. Attempts and total time are both bounded.
4. **Fail closed.** If the anonymity network is down or an answer can't be proven, the read returns an error. DeRPC never makes a direct RPC request.

Wallet integrators are the first audience, demonstrated through a browser app.

### What it does not do

- **It hides who is asking, not what is asked.** Endpoints still see query content and timing.
- **Its read-only EIP-1193/viem provider supports balance, nonce, code and storage.** The block number comes from the verified header. Generic `eth_call`, logs and transactions are outside this reader. Checking arbitrary execution would need local execution against proven state, which is later work. The integrator surface is documented in [`provider/README.md`](provider/README.md).
- **Isolation between accounts depends on the worker.** tor-js 0.4.4 documents a separate circuit per isolation key. We have observed it once but not proven it, so DeRPC makes no unlinkability claim yet.
- **The endpoint list is curated** for now. Several URLs don't prove several independent operators.
- **The roots of trust are the pinned checkpoint and the pinned worker hash.** The app refuses a checkpoint older than 7 days.

## What works today

- **Anonymous transport in the browser.** The real tor-js 0.4.4 worker runs in `@anon-rpc/browser-harness`.
  - Booting it makes zero RPC requests. The harness needs two reads from the worker's on-chain specifier contract (`workerHash()` and `workerResolvers()`); DeRPC answers both from a local pin and refuses any other call. The harness hash-checks the downloaded bundle before running it.
  - Once the worker fails, every call errors. Nothing falls back to a direct request.
  - Boot took 3.0 s through our own `tor-js-gateway` and 6.6 s on the tor-js demo gateway. One demo-gateway run took 49 s, because its fast bootstrap timed out and tor-js downloaded the Tor directory itself.
- **Real mainnet proofs through Tor.** `eth_getProof` at the finalized block works through the worker on dRPC, MEV Blocker, BlockRazor and Blast: 13.7 KB per proof, 0.9–4.8 s each. publicnode is unreliable for proofs through Tor.
- **Verified headers.** The Lodestar light client (1.43.0) starts from a pinned mainnet checkpoint, with every beacon request going through the worker.
  - It reports a finalized execution header (block number, block hash, state root) only after a sync-committee-signed update verifies.
  - It refuses a checkpoint older than 7 days and a finalized header older than 30 minutes.
  - It polls for head updates instead of opening the beacon node's event stream, because `EventSource` would connect outside the worker.
- **A light-client security fix.** Lodestar 1.43.0 lets a beacon endpoint plant a fake finalized header, and with it a fake state root. Lodestar fixed this in its core repo (PR #9419) after the light client had moved out. DeRPC ships the fix as a local patch, with a regression test that replays the attack.
- **Verified account, storage and code reads.** The host checks EIP-1186 proofs against the verified state root, derives balances and nonces, and checks code against the proven code hash. Tests cover altered claims, wrong addresses/slots/roots, absence proofs, and truncated or padded proofs. WETH balances use its known `balanceOf` mapping at slot 3; this is not generic token support.
- **On-chain worker-pin verification.** After startup, the demo proves the mainnet specifier's `workerHash` in slot 1 and compares it with the local pin. Its read gate waits for that proof and refuses reads if the check fails. Lower-level library helpers still require the integrator to compose this gate explicitly.
- **Endpoint failover.** The pool selects among dRPC, MEV Blocker and BlockRazor first, with Blast and PublicNode as fallbacks. Invalid proofs cause local exclusion; timeouts and other transient errors cause cooldowns. Verified values are cached locally. Retry isolation keys are derived from the account key; stronger circuit-isolation guarantees remain unproven.
- **A demo page** showing worker startup, the verified header, worker-pin status, ETH/WETH balances, verified code and pool events. Controls inject a clearly labeled corrupt response and close the worker. Its resource-timing table shows some direct connections; it does not capture every browser connection or the WebRTC gateway link.

**Still pending:** submission materials and a browser rerun of the fixes below. The telemetry and automated checks cover worker loss, cancellation and network outages, but not every browser or network failure mode.

### QA checklist — Nov 5

- [x] Workspace type checking and the production build pass.
- [x] All 193 provider tests and 74 frontend tests pass, including the Lodestar finality regression, worker-pin gate, pool selection, exclusion, cooldown and failover tests.
- [x] A fresh Firefox profile runs the production build through tor-js: the pin gate passes, and ETH balance, WETH balance and contract-code reads verify.
- [x] All five candidate execution endpoints and both beacon endpoints respond through Tor in this run. One of four Tor-exit probes fails with a TLS `CONNRESET`; the other three report `IsTor=true`.
- [x] In the production Firefox demo, an inflated balance is rejected, the simulated endpoint is excluded, and another endpoint supplies verified results.
- [x] Closing the worker makes all three subsequent reads fail with `TransportUnavailableError`.
- [x] Browser request events show only local page assets and jsDelivr, with no direct RPC or beacon HTTP requests during successful reads, simulated corruption/failover or worker shutdown. This does not audit the WebRTC gateway connection or establish every failure path.
- [x] Worker and network errors render as text.
- [x] Polling recovers after an invalid update.
- [x] A read's freshness is rechecked before it returns.
- [x] The pool's total deadline applies during an attempt, and a late response is discarded.
- [x] One verified block is kept across retries and in the cache entry.
- [x] Automated tests cover cancellation, worker crashes, pool exhaustion and network loss.
- [ ] Rerun the production build in Firefox with these fixes, including browser traffic inspection. The Firefox results above predate them.

This prototype has had no external audit and isn't ready for production. The production build also reports browser-externalized Node modules and a large main bundle; its successful Firefox run does not establish support for every browser. See [`THREAT_MODEL.md`](THREAT_MODEL.md).

### Traffic outside the worker

| Traffic | Through the worker? | Notes |
|---|---|---|
| RPC reads (`eth_getProof`) | Yes | |
| Light-client beacon requests (bootstrap, updates) | Yes | Polled, no event stream |
| Worker bootstrap reads (`workerHash()`, `workerResolvers()`) | No request is made | Answered from the local pin. After startup, slot 1 is proven through the worker before the demo serves verified reads. |
| Worker bundle download | No, direct | From jsDelivr. Hash-checked, but it shows the server that this IP is loading tor-js. |
| Tor gateway connection | No, direct (WebRTC) | The gateway sees the client's IP but only relays encrypted Tor traffic |
| Page assets | No, direct | Served by whoever hosts the page |

## Integrator API

`createDeRPC()` returns a read-only EIP-1193 provider; `@derpc/provider/viem` wraps it as a viem transport. It serves `eth_chainId`, `net_version`, `eth_accounts`, `eth_blockNumber`, `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode` and `eth_getStorageAt` at the verified finalized block. Everything else is refused rather than forwarded.

The full surface — supported methods, finalized-block rules, initialization, status, cancellation, timeouts and error codes — is in [`provider/README.md`](provider/README.md). The smallest browser integration is [`frontend/src/example.ts`](frontend/src/example.ts), which imports only the public package.

## CROPS

The lead property is **Private**, and **Secure** backs it up: the proofs let DeRPC use endpoints it doesn't trust.

- **C (censorship resistant):** The app is a static build with no required DeRPC RPC proxy. Endpoints and Tor gateways are replaceable lists (set your own gateway with `VITE_TOR_GATEWAYS`), and endpoint failover works in the demo. Availability still depends on reachable endpoints and a Tor gateway; failed routes never trigger direct RPC fallback.
- **O (open source):** MIT. `pnpm install && pnpm dev` builds and runs it from this repo alone, with no keys or accounts. The one recurring step is refreshing the pinned checkpoint, which is refused after 7 days.
- **P (private):** RPC and beacon endpoints see each query and its timing, but from a Tor exit's IP instead of the user's. The Tor gateway sees the user's IP but only encrypted traffic, and the exit sees which endpoint is contacted but not the content, because TLS runs inside the worker. jsDelivr sees the IP that downloads the worker, and the page host sees visitors as any website does. There are no analytics or DeRPC servers, and account isolation is not yet proven.
- **S (secure):** DeRPC is read-only, with no wallet keys or signing. The host verifies headers, account/storage/code proofs and the worker pin, relying on the pinned checkpoint, bundle hash and light-client consensus assumptions. See [`THREAT_MODEL.md`](THREAT_MODEL.md) for what this does and doesn't protect against.

## Run it

Tested with Node 24.16.0 and pnpm 11.22.0. The workspace pins the pnpm version in `package.json`.

```sh
pnpm install
pnpm dev                              # check page at http://localhost:5173
pnpm --filter @derpc/provider test    # provider tests (recorded beacon/proof data, no network)
pnpm typecheck
pnpm build
```

- **Tor gateway.** By default the page uses the tor-js demo gateway, which has limited capacity and may disappear. To use your own [`tor-js-gateway`](https://github.com/ethereum/tor-js), copy `frontend/.env.example` to `frontend/.env.local` and set `VITE_TOR_GATEWAYS`.
- **Checkpoint.** The pinned checkpoint dates from Nov 5, 2026, and is refused after 7 days. Refresh `MAINNET_CHECKPOINT` in `provider/src/config/mainnet.ts` before running it after Nov 12.

## Roadmap

Progress is tracked in [issue #1](https://github.com/r0bops/DeRPC/issues/1).

### This weekend

| Phase | Goal | Status |
|---|---|---|
| P0 | Choose the light client, worker and chain | **Done.** Lodestar light client 1.43.0, tor-js 0.4.4, Ethereum mainnet; Nym remains an untested backup |
| P1 | A real anonymous network path | **Passed.** Proofs and light-client data arrive through Tor, with no direct RPC. Isolation-key behavior is still unproven. |
| P2 | One verified read path: ETH balance and one ERC-20 balance checked against verified state, and the worker pin proven on-chain | **Implemented in the demo; browser rerun pending.** Proofs, the pin gate, error rendering, polling recovery and read freshness are done. |
| P3 | A working pool: at least two endpoints, random selection, local exclusion, bounded anonymous failover | **Three-step browser demo passes; browser rerun pending.** Total-deadline enforcement, stable block binding and failure tests are done. |
| P4 | An EIP-1193 provider and viem transport, plus a demo screen | **Implemented.** Read-only EIP-1193 provider, viem transport and integrator example; browser sign-off pending. |
| P5 | Threat model, failure tests, docs and demo video | **Partial.** README, QA checklist, threat model and automated failure tests exist; the demo video and submission materials remain. |

The browser demo shows three things:

1. The page reads a verified balance through the pooled reader and shows the selected endpoint and verified block.
2. A clearly labeled corrupt response fails the proof check. The endpoint is excluded locally, and another endpoint supplies a verified answer.
3. With the anonymity worker closed, DeRPC fails closed and makes no direct RPC request.

**Stretch, only if the core demo is done early:** an operator registry under `derpc.eth` on ENSv2. DeRPC would read it through Anon-RPC and prove it with the same light client.

### After the hackathon

1. **Wallet and app adoption.** A stable provider interface, measured performance, and a first external integration, with Kohaku as the target.
2. **Server-side agents.** An isolated runtime that carries real anonymous traffic, with the same verification and failure guarantees.
3. **More EVM chains.** Each needs its own authenticated headers, proof format, finality rules and working endpoints. Transport compatibility alone isn't enough.
4. **Distributed operator discovery.** A replaceable registry with explicit governance. Open registration needs Sybil resistance.
5. **Client-side scoring.** Local success and latency measurements, random exploration, and limits on how much traffic any one operator gets.
6. **Signed accountability.** Responses bound to operator, request, chain and block, so misbehavior can be shown to others before any penalty.
7. **Optional operator economics.** Credits or payments only after demand and privacy are worked out. No token is required.
8. **Richer verified reads and query privacy.** `eth_call` through local execution against proven state, and research into private information retrieval.

**Known risk:** the Lodestar light client is no longer maintained and doesn't support the next fork (Gloas). Mainnet has no Gloas date yet; once it does, the light client must be replaced. It sits behind a small interface so it can be swapped.

## Built with

[`@anon-rpc/browser-harness`](https://github.com/ethereum/anon-rpc), the [tor-js](https://github.com/ethereum/tor-js) worker, the [Lodestar](https://github.com/ChainSafe/lodestar) light client, TypeScript, Vite, pnpm and Vitest.

## License

[MIT](LICENSE)
