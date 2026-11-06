# Prize tracks: ETHGlobal Mumbai 2026

Source: ETHGlobal Mumbai prize pages, pasted on Nov 5, 2026. Only the from-scratch prizes are listed here. Continuity Track prizes are left out because DeRPC is a new project.

## Where DeRPC fits

| Prize | Fit | Plan |
|---|---|---|
| **EF: Best Use of Anon-RPC** | Direct. "Combine anon-rpc with a light client or proof verification" is one of their listed ideas. | **Primary.** |
| **EF: Best CROPS App** | Strong. The lead property is Private, and the proofs back up Secure. Their demo example "swap the RPC provider" is our demo step 2. | **Also enter it.** It costs only a README section and a video under 3 minutes. The EF places a project in at most one EF prize, so entering doesn't hurt. |
| **ENS: Best Use of ENSv2** | Good, as an operator registry (roadmap step 4). ENS lives on Ethereum itself, so a light client for the registry's chain and `eth_getProof` can prove the operator list. | **Day-2 stretch, gated.** See the ENS section below. |
| Arkiv: Mirror something Ethereum depends on | Partial. "Chain and RPC registries" is one of their ideas. But Arkiv is a separate chain our light client can't verify. | **Backup only.** ENS replaces it as the stretch. |
| EF: Frame Transaction Alt Mempool | No. That track is about writes and transactions; DeRPC is about reads. | Skip. |
| World, 1inch, 0G, Uniswap, Arc, Hedera, Whitechain, Definitive, Chainlink | No. | Skip. |
| ENS: Best Integration of ENSv2 into an Existing Project | Not eligible. It's a Continuity Track prize. | Skip. |

ETHGlobal limits each project to **three partner-prize picks**. A partner with several tracks counts as one pick, and you're eligible for all of its tracks. Planned picks: EF (Anon-RPC and CROPS together), plus ENS if the stretch ships. Submission rules are in [SUBMISSION.md](SUBMISSION.md).

---

## Ethereum Foundation ($15,000)

The EF Access Layer team builds the pieces that keep apps and wallets **CROPS**: censorship resistant, open source, private and secure. At Mumbai they are bringing Anon-RPC and the EIP-8141 alternative mempool.

**One EF prize per project.** You can submit to Anon-RPC, the alt mempool and CROPS, but the EF judges place you in at most one.

**Workshop:** "Building with Anon-RPC and the alt mempool", 5:00 PM IST, Thu Nov 5, Workshop Room 2, with Andrew Morris on Anon-RPC. It has passed, so take the open questions in CONTEXT.md §9 to the EF booth or mentors instead.

### Best Use of Anon-RPC: $5,000 (1st $2,500, 2nd $1,500, 3rd $1,000)

Use Anon-RPC as an app that consumes it, produce anonymity with a new worker, or both. You can also implement or fork the harness for a new platform.

Their listed ideas: portfolio dashboard, block explorer, fork of an existing dApp, network health checker or playground, **combine anon-rpc with a light client or proof verification**, new network, new harness.

**Judging criteria:**
1. Works end to end in the demo.
2. Quality of the user experience in the demo.
3. How much of the app's traffic goes through Anon-RPC. If some traffic is left out on purpose as a performance or anonymity tradeoff, rather than because it was hard to build, that can count in your favor. Just tell them.
4. Could it be shipped for real after the hackathon.
5. Technical depth.

**Qualification:** the app routes its RPC reads through Anon-RPC by default. If you build a worker or a harness, a simple demo app is enough.

**What this means for DeRPC:**
- **On by default.** A settings toggle that starts off, as in Kiwi News, would **not** qualify.
- **Declare what bypasses Anon-RPC** in a small README table: the worker-hash bootstrap read (unless pinned), the worker bundle download, and light-client updates if they're fetched directly. Better still, send light-client updates through the worker once it's up.
- Aim for 100% of traffic through the worker. That includes the light client's beacon and checkpoint fetches and the bootstrap `workerHash()` read, not only `eth_getProof`.
- **Demo UX:** tor-js takes about 20 seconds to boot, so start it early and show progress. Show a clear verified or rejected state on every row. Record a backup video as soon as the flow first works.
- **Shippable:** package the verifier as a provider library, separate from the demo page, with Kohaku as the integration target.
- A "network health checker" page that probes and scores RPCs is also on their idea list. CONTEXT.md keeps scoring on the roadmap (step 5), so this stays out of scope unless the team pulls it back in.
- Explain why this MVP refuses `eth_call`: raw responses carry no proof, and local execution against proven state is later work.
- Make "shippable after the hackathon" concrete: point to the Kohaku integration path and the roadmap.

Links: [homepage and demo](https://ethereum.github.io/anon-rpc/) · [wallet and app guide](https://ethereum.github.io/anon-rpc/wallets/) · [network guide](https://ethereum.github.io/anon-rpc/networks/) · [GitHub](https://github.com/ethereum/anon-rpc) · [browser harness](https://www.npmjs.com/package/@anon-rpc/browser-harness) · [browser extension harness](https://www.npmjs.com/package/@anon-rpc/browser-extension-harness)

### Best CROPS App: $3,500 (1st $2,000, 2nd $1,000, 3rd $500)

Build an app, wallet feature or dev tool where one CROPS property is the reason it exists, without giving up the other three. Their ideas include "a frontend that keeps working when its domain, backend or RPC provider disappears" and "a tool that shows what an app leaks (RPC calls…)".

**Judging criteria:**
1. Works end to end in the demo.
2. Depth of the lead property. Structural (it works without you) beats cosmetic (a setting).
3. The other three properties still hold, or the README states the tradeoffs.
4. UX: would someone use it without knowing what CROPS means?
5. Could it ship after the hackathon?

**Qualification:**
- [ ] Public repo under a FOSS license (MIT here), with a README that explains how to run it.
- [ ] A README section titled **CROPS**, with one or two lines per letter:
  - **C:** what you control that the user depends on (domain, server, RPC, relayer), and what happens if it goes away or refuses them.
  - **O:** the license, and whether a user can build and run it from the repo alone.
  - **P:** what each third party (your server, RPC provider, analytics, indexers) learns about the user.
  - **S:** how keys and user data are protected, and the trust assumptions.
- [ ] A demo video, **3 minutes max**, showing the lead property working end to end, including the moment it matters (for example, swapping the RPC provider).
- [ ] No third-party trackers or analytics in the client. Keys and personal data stay on the user's device.

Links: [EF mandate (what CROPS means)](https://blog.ethereum.org/2026/03/13/ef-mandate) · [Kohaku](https://github.com/ethereum/kohaku) · [Walletbeat](https://walletbeat.eth.limo) · [Scaffold-ETH 2](https://github.com/scaffold-eth/scaffold-eth-2)

### Best use of the Frame Transaction Alternative Mempool: $5,000 (not a fit)

This prize covers EIP-8141 frame transactions and the ERC-8421 alternative mempool. It is about writes and transactions, not reads. Listed here only for completeness.

---

## ENS: Best Use of ENSv2, $7,000 (1st $3,000, 2nd $2,000, 3rd $1,000, 4th $1,000). Day-2 stretch, gated.

ENSv2 is live on Ethereum mainnet. They want builds on the new hierarchical registry: subname registries, wildcard resolution, Enhanced Access Control (role-based permissions, such as letting an account edit only certain text records), a Permissioned Resolver per subname, record and namespace aliasing, and subnames that can expire, be revoked, or be made non-transferable. Bonus points for AI agents as namespaces (not relevant to DeRPC).

**Qualification:**
- [ ] Built on ENSv2 on Ethereum mainnet or Sepolia.
- [ ] ENSv2 features are central to the product, not a cosmetic add-on.
- [ ] The demo works for real, with no hard-coded values.
- [ ] The project page links to a live demo, and the code is open source on GitHub.

**DeRPC angle: an ENSv2 operator registry.** This is an unstaked, curated version of roadmap step 4. Execution priorities and the no-extra-chain-verifier gate are in [ROADMAP.md](ROADMAP.md).

**Nov 6 milestone plan:** [M1 — ENS-managed private RPC operators](ENS_TOR_MILESTONE.md) defines the real discovery, restricted endpoint rotation, registrar delisting and multiple-onion-endpoint demonstration. It separates code/fork evidence from live completion and keeps payments/staking deferred. ENS-to-onion naming alone is not the novelty claim; the intended demonstration combines ENSv2 management with anonymous, locally verified discovery and reads.

| ENSv2 feature | Use in DeRPC |
|---|---|
| Subname registry under `derpc.eth` | One subname per operator, such as `alice.derpc.eth` |
| Enhanced Access Control | An operator can edit only its own endpoint records. The curator keeps the right to revoke. |
| Revocable admission | The registrar can delist an operator; clients enforce it after finalized, verified refresh. The current `remove` method does not burn the ENS token. |
| Expiring subnames | A listing lapses unless the operator renews it, so dead endpoints drop out |
| Permissioned Resolver | Each operator owns its records: URL, chains, `eth_getProof` support |

**The pitch:** DeRPC fetches operator information through Anon-RPC and proves the list and on-chain records against authenticated Ethereum state. This reuses its verification path while retaining explicit checkpoint, contract-pin and curator assumptions. The published directory remains retrievable if our website disappears.

**Gate:** start only if the hour-6 go/no-go passed and the 3-step demo works by about midday Fri Nov 6, IST.

**Minimal version:**
- [ ] A registry on mainnet ENSv2 under `derpc.eth` (registered; decided Nov 6) with 2–3 operator subnames carrying endpoint text records, one resolver per operator.
- [ ] DeRPC reads the list and records through Anon-RPC, labeled "unverified discovery". The list becomes provable with a registrar that keeps it in our own storage layout; the records need verified `eth_call`. Steps: ROADMAP.md, "Gated stretch: ENS operator registry".
- [ ] The demo shows one revoke: the operator drops out of the pool for everyone.

**Known problems:**
- **`eth_call` conflict.** Normal ENS resolution uses `eth_call` (the Universal Resolver), which DeRPC refuses. Read the resolver's storage slots directly instead. This needs ENSv2's storage layouts, which aren't checked yet. If it takes too long, fall back to an `eth_call` read through Anon-RPC, labeled "unverified discovery".
- **No offchain resolution.** Wildcard or CCIP-Read answers can't be proven, so operator records must live onchain.
- **Subnames can't be listed from storage.** Keep an index, for example a text record on the parent name that lists the operator labels.
- **One network.** Keep registry, demo reads and worker-specifier verification on the same chain where possible. The recorded Tor/Nym specifiers are on mainnet, so a Sepolia registry/demo may still require a second verifier. Skip the stretch if it expands the core verification scope. **Nov 6:** the registry goes on mainnet, where ENSv2 is in use and `derpc.eth` is registered, so everything stays on one chain.
- **Integrity doesn't depend on it.** Answers are proven anyway, so the registry only affects availability and who decides who's in the pool. Be ready to say that to judges.

Links: [ENSv2 overview](https://docs.ens.domains/ensv2/overview/) · [Permissioned Registry](https://docs.ens.domains/ensv2/permissioned-registry) · [Permissioned Resolver](https://docs.ens.domains/ensv2/permissioned-resolver/) · [Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/) · [Guide for contract developers](https://docs.ens.domains/ensv2/tutorial-contract-developers/) · [ens-cli](https://github.com/ensdomains/ens-cli)

**Workshop:** "ENSv2: Identity for Apps, Agents & Beyond", 4:00 PM IST, Thu Nov 5, Workshop Room 1. It has passed, so ask at the ENS booth about storage layouts, Sepolia support, and how to enumerate subnames.

---

## Arkiv: Mirror something Ethereum depends on, $4,000 (1st $3,000, 2nd $1,000). Backup only.

ENS replaced Arkiv as the stretch, because ENS lives on Ethereum itself and our light client can prove it, while Arkiv is a separate chain.

From the Grok chat (not checked): Arkiv would add about 4–6 hours, mostly the import script and docs, and Chainlist's data is GPL-3.0, which allows republishing.

Mirror public data that Ethereum apps rely on into Arkiv entities that anyone can query. Their ideas include **chain and RPC registries**.

Possible DeRPC angle: mirror an RPC endpoint registry into Arkiv, enriched with our own probe results (does the endpoint support `eth_getProof`? does it accept Tor exits?). DeRPC would then read its operator list from Arkiv. Because every answer is proven, a bad list can only hurt availability, never correctness.

**Judging (25% each), one file per criterion:** `/arkiv/friction.md`, `/arkiv/reach.md`, `/arkiv/why-arkiv.md`, `/arkiv/data-quality.md`.

**Qualification:**
- Built from scratch at the event.
- The data's license allows republishing, linked in the README. Not Sourcify data.
- The import script is in the repo and can be re-run.
- The project writes to the Arkiv testnet (`@arkiv-network/sdk` or JSON-RPC), and a feature people use reads from it.
- The README lists the writer wallet addresses and one query judges can run.
- `/arkiv/schema.md` and `/arkiv/friction.md` are in the repo.
- The repo is open source, and AI use is disclosed.

Testnet: RPC `https://rpc.rabdi.db-chain.testnet.arkiv.network` · chain ID 7794095 · [explorer](https://rabdi.explorer.arkiv.network) · [faucet](https://hub.arkiv.network/faucet) · [docs](https://docs.arkiv.network)

The optional Arkiv + Swarm bonus ($500) is out of scope.

---

## Finalist prizes (if selected)

| Team size | Prize per person | Travel per person |
|---|---|---|
| Solo | 250 USDC | none |
| 2 people | 250 USDC | 250 USDC |
| 3–5 people | 1,000 USDC | 500 USDC |

Every finalist also gets $828 off ETHGlobal Plus, a finalist hoodie, and $10,000 in AWS credits.

## Other sponsors (not a fit, for reference)

| Sponsor | Pool | What they want |
|---|---|---|
| World | $12,500 | World ID Agent Pass or IDKit gating an action that needs a human |
| 1inch | $7,000 | Aqua or SwapVM DeFi positions |
| 0G | $15,000 | Consumer AI apps on 0G Private Computer, physical AI, self-funding agents |
| Uniswap Foundation | $15,000 | Anything on the Uniswap stack, plus FEEDBACK.md |
| Arc (Circle) | $15,000 | Apps built in Arc Studio with USDC or EURC |
| Hedera | $15,000 | x402 agent payments, tokenization studios, SDK-only apps |
| Whitechain | $15,000 | USDT payments and RWA flows on the Whitechain OP Stack L2 |
| Definitive | $5,000 | Flash API advanced orders in social trading |
| Chainlink | $5,000 | CRE workflows, CCIP 2.0 |
