# Partner integration feedback

Prepared from DeRPC's implementation and recorded tests on November 6, 2026. These are integration observations and suggestions, not feedback already delivered to partner teams. [The submission draft](specs/SUBMISSION_DRAFT.md) contains shorter text for the form.

## Ethereum Foundation: Anon-RPC

We use the Anon-RPC browser harness with the pinned tor-js worker for execution requests, beacon synchronization, ENS discovery and onion identity checks. The host verifies consensus and EIP-1186 proofs, and it refuses reads if the anonymous path dies. The [upstream integration notes](specs/ANON_RPC.md) record the API and spec assumptions.

What worked:

- The fetch interface let the same worker carry both JSON-RPC and beacon REST requests. Keeping proof verification in the host preserved the worker's untrusted boundary.
- Local answers to both specifier bootstrap calls removed the need for a direct bootstrap RPC. The harness's bundle hash check and a later proven on-chain hash check serve different, useful purposes.
- The existing gateway and onion support made an all-onion execution/consensus path practical. [The recorded run](wrapper/test/onion-availability-evidence-2026-11-06.json) includes startup, proven reads and shutdown refusal.

Friction and suggested improvements:

- Gateway startup failures can be hard to distinguish from Tor bootstrap, hidden-service descriptor or rendezvous failures. Structured phase, timeout and retry diagnostics would help integrators explain progress without logging user query contents. Our bounded diagnostic observed descriptor/rendezvous recovery; it does not explain every earlier timeout.
- Bundle delivery and gateway setup occur outside the already-running worker. A documented gateway-hosted bundle example, explicit cancellation behavior and clear failure reporting would make this privacy boundary easier to implement and explain.
- `isolationKey` is worker-dependent. An interoperability test for circuit reuse, separation and retry behavior would be more useful than treating the presence of the option as an unlinkability guarantee.
- The Node harness is documented as not yet conforming in our pinned reference. A conforming server runtime would enable an agent integration with the same tested anonymity boundary as the browser.

Our separate Lodestar maintenance and fork-compatibility problems are not harness defects. We patched finality/lifecycle behavior and disabled unsafe forced updates; those choices and their remaining live-transition check are disclosed in the provider documentation.

## ENS: ENSv2

We built an expiring curated registrar, dedicated resolvers, unsigned deployment/lifecycle tools, proof-backed discovery and bounded local resolver execution. Tests use actual pinned ENS bytecode on a local fork. The deployed public operator directory and independent operator lifecycle demonstration are still pending; this feedback does not imply ENS prize qualification.

What worked:

- The hierarchical registry and role controls fit operator admission, expiry and restricted operational changes.
- One resolver per operator makes the intended ownership boundary explicit. The hot key can be limited to endpoint records while the cold owner retains broader authority.
- Local execution of resolver calls against proven code/storage avoids assuming a fixed resolver storage layout and works across the proxy boundary within the executor's limits.

Friction and suggested improvements:

- A complete minimal deployment example should distinguish factory provenance, parent attachment, registrar membership, resolver ownership and key-specific roles. Each must be checked before claiming the end-to-end identity binding.
- The lack of an enumerable operator list led us to maintain a bounded registrar layout. An example for authenticated enumeration and expiry would help applications that cannot trust an indexer's response.
- Role scope and revocation semantics deserve concrete negative examples: changing another operator's record must fail, and registrar delisting need not burn a token. Our lifecycle tooling tests these differences.
- Documentation for proof-backed clients should separate fully on-chain resolution from CCIP-Read, explain proxy dependencies, and provide mainnet-fork fixtures. Off-chain answers cannot be promoted to proven state merely because their entry point is ENS.

Before submitting for ENS, attach the real deployment, operator records, roles and finalized rotation/delisting evidence described in [M1](specs/ENS_TOR_MILESTONE.md). Local fork tests are not a replacement.
