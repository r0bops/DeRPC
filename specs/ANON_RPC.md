# Anon-RPC: reference notes for DeRPC

Upstream: <https://github.com/ethereum/anon-rpc>. This is the main dependency. DeRPC is a host-side wrapper around its harness.

- **Local copy:** `reference/anon-rpc/`, a shallow clone at `c8980fb` (spec **v0.4.0**, Oct 23 2026). It's gitignored because it's reference material, not our code. If the folder is missing:
  `git clone --depth 1 https://github.com/ethereum/anon-rpc reference/anon-rpc`
- **Normative source:** `reference/anon-rpc/SPEC.md`. When this file and the spec disagree, the spec wins.

## Where to look

| Need | File |
|---|---|
| Normative spec (host API §5, isolation §6, capability API §7, `anonOptions` §9.3, errors §12, security §14) | `reference/anon-rpc/SPEC.md` |
| Wallet integration guide, including its own honest trust model | `reference/anon-rpc/docs/integrate-wallet.md` |
| Network (worker) integration guide | `reference/anon-rpc/docs/integrate-network.md` |
| Known workers, specifier addresses, example configs, adopters | `reference/anon-rpc/adopters.json5` |
| How the harness reads the specifier (the bootstrap) | `reference/anon-rpc/impl/harness-core/src/specifier.ts` |
| Browser harness, host side (`@anon-rpc/browser-harness`) | `reference/anon-rpc/impl/browser-harness/` (README, `src/host/AnonRpcWorker.ts`) |
| Specifier contract (storage layout) | `reference/anon-rpc/impl/specifier/src/WorkerSpecifier.sol` |
| Minimal worker template | `reference/anon-rpc/impl/passthrough-worker/src/passthrough-worker.ts` |
| Node harness (QuickJS, **not yet conforming**, about 50× slower) | `reference/anon-rpc/impl/node-harness/README.md` |

## The parts DeRPC touches

**Host API (§5):**

```ts
const worker = new AnonRpcWorker({
  address,                       // specifier contract
  config,                        // plain value, worker-defined schema (tor-js: { gateways: [...] })
  iframeUrl,                     // only for strict-CSP embedders
  preExisting: { rpcProvider },  // EIP-1193 { request } used ONLY for the bootstrap read
});
worker.ready;      // rejects on hash mismatch, worker crash or signalFailed(); failure is FINAL
worker.fetch;      // standard, this-bound fetch: pass it as a free function
worker.acceptLog();
worker.close();
```

- Use **one long-lived worker per network**. Calls made before `ready` are buffered in order.
- After a failure, `ready` rejects and every pending and future `fetch` fails. This is DeRPC's fail-closed hook: surface the error and never route around it.
- Errors are `RpcError` with a `code`. Branch on `code`, never on `message`.
- Per-call options: `worker.fetch(url, { …, anonOptions: { isolationKey } })`. **Each worker decides whether to honor `isolationKey`** ("support varies").

**Isolation (§6, §14):** worker code is untrusted. Hash pinning is the supply-chain control. The wallet guide says the worker "holds the same position as any RPC endpoint… a malicious worker can observe, censor, or lie." DeRPC closes the "lie" part.

## Deployed workers (read on Nov 5, 2026 through a public RPC, not verified)

| Worker | Specifier | Chain | Owner (slot 0) | `workerHash` (slot 1) | Notes |
|---|---|---|---|---|---|
| passthrough | `0x4fd77be300f31c5fe6ab266d35d27750a3478d27` | mainnet | `0x6d25…0915` | `0x194f04bd…45338d` | Reference only, **no anonymity** |
| tor-js | `0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e` | mainnet | `0x6d25…0915` | `0x5b62f358…ec818b` | Needs `config.gateways` (KPS relays into Tor). The demo gateway has limited capacity and "may disappear at any time". |
| Nym | `0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0` | mainnet | `0xd8d4…4518` | `0xf13a448a…1fceb8` | About 18 MB bundle, a few seconds to bootstrap |
| Nox | `0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A` | **Sepolia** | `0xb18d…69c5` | `0xd9fa04b0…e838d4` | TLS runs inside the worker, so the exit can't read requests. Mixing adds delay. |

Adopters: Privacy Pools and Kiwi News (both tor-js, both opt-in). Kiwi News already **fails over to the next RPC provider when one refuses Tor traffic**, which is prior art for our operator failover. It also starts the worker early while the browser is idle (anon-rpc PR #13). Kohaku is adding an anon-rpc backend next to its ethers, viem, helios and colibri backends (kohaku PR #271).

## Findings that affect the DeRPC design

1. **The bootstrap makes two `eth_call` requests.** `readSpecifier()` calls `workerHash()` (`0x3898587d`) and `workerResolvers()` at `"latest"` through `preExisting.rpcProvider`, then fetches the bundle and checks its keccak hash. The wallet guide's "trusted for one read" describes the integrity-critical hash read, but both calls need local answers to eliminate direct bootstrap RPC traffic.
2. **A verified bootstrap is feasible.** All four deployed specifiers use the reference `WorkerSpecifier` layout. Slot 0 is the owner, **slot 1 is `workerHash`**, and slot 2 is the resolvers array length. We checked that slot 1 equals `workerHash()` for each one. So DeRPC can pass an `rpcProvider` that answers the `workerHash()` call from `eth_getProof(specifier, [0x1])`, checked against a state root from the light client. `workerResolvers()` can stay unproven, because it's advisory and the bundle bytes are hash-checked anyway.
3. **Chicken-and-egg problem.** The light client needs network access to check the bootstrap, but the worker that would carry that traffic doesn't exist yet. There are two ways out:
   - **(a) Direct bootstrap.** Sync the light client and fetch the proof directly, before any account query. This conflicts with "never connects directly", so it would have to be declared to the judges.
   - **(b) Pin, then verify.** DeRPC ships with a pinned `workerHash` and resolver list and answers both bootstrap calls locally. Once the worker is up, the light client syncs **through it** and proves slot 1 equals the pin at the verified block. User reads wait for this check. A mismatch or inability to verify means stop. This needs zero unanonymized RPC reads and detects finalized owner changes that no longer match the pin (point 5).
   - Option (b) is the planned approach in CONTEXT.md and ROADMAP.md; the implementation still needs to pass its gates. Verify the specifier on its own chain: the recorded Tor/Nym contracts are on mainnet even if application reads target Sepolia.
4. **Bundle acquisition happens before the anonymous worker exists.** The harness fetches `https:` resolvers with a plain host `fetch`; it also supports KPS resolvers and locally held `blob:` bytes. A remote bundle server can learn that the client IP is loading worker X. Declare this separately from RPC traffic; pinning the hash protects bundle integrity, not download anonymity.
   - **Nov 6 integration:** when a pin advertises the exact hash-addressed KPS layout, DeRPC's local bootstrap prepends mirrors at the configured gateway addresses and ABI-encodes the advisory resolver list. It retains the original resolver fallbacks and never changes the hash or recorded raw pin. A working gateway mirror avoids the separate CDN request; it does not anonymize gateway acquisition. Other worker pins retain their raw resolver behavior. Browser-harness 0.4.0 still controls bundle fetch cancellation/body deadlines; resolver ordering alone does not add a body deadline.
5. **The specifier owner is the supply chain.** None of the four specifiers has given up ownership, so each owner can still change the hash. passthrough and tor-js share an owner. A verified bootstrap stops a lying RPC, **not** an owner update. Pinning (3b) covers both.
6. **`isolationKey` is honored by the worker or not at all.** Before claiming "accounts unlinkable", check whether tor-js maps keys to separate circuits. The honest claim depends on it. According to the planning conversation, a tor-js test saw five requests for five addresses leave through one exit, and tor-js PR #17 adds per-key circuit isolation. Check that it's merged and included in the deployed bundle.
7. **Demo risk with tor-js.** It depends on a gateway. Keep Nym as the backup, or run your own tor-js gateway.
8. **Use the browser harness for the demo.** The Node harness isn't conforming and runs workers about 50× slower. It may still be useful for unit tests.

## Updating the worker pin (#6)

DeRPC boots the worker from a local pin (`provider/src/config/mainnet.ts`). Before any user read, it proves the specifier contract's storage slot 1 (`workerHash`) against the light client's verified state, through the worker, and refuses every read if the proof fails or the hash differs. The check runs on the specifier's own chain (mainnet for tor-js and Nym). It shows agreement at the verified block, not instant knowledge of a later owner update.

The pin never changes automatically, and never from an unverified RPC answer. When the worker owner publishes a new version (or a user sees "worker pin rejected"), a person updates it:

1. Read `workerHash()` and `workerResolvers()` from the specifier, and check that the on-chain hash changed on purpose: the network's release notes and the owner's announcement.
2. Rebuild or download the new bundle and confirm its keccak256 equals the new `workerHash`. Review what changed in the worker (its source and changelog), because the bundle sees every request.
3. Update `workerHash`, `resolvers` and `resolversRaw` in `provider/src/config/mainnet.ts` in one commit, with a message that names the old and new hashes.
4. Run the demo page (`frontend/index.html`) and choose an operator: the worker must boot, and the worker pin must show "verified" with the new hash at a recent block.

`test/fixtures/record-worker-pin.mjs` records a fresh proof of slot 1 for the tests when the pin changes.
