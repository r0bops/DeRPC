# Prize tracks

Which ETHGlobal Mumbai prizes DeRPC targets, and what the repo supports today. Claims here must match the README and the code.

The free browser provider routes execution and consensus requests through Anon-RPC, authenticates finalized Ethereum state, checks account/storage/code proofs in the host and fails closed. Manual and explicit automatic selection use a curated bootstrap roster whose ENS names are marked as mock. The repository also implements an onion wrapper, ENS registrar/discovery, bounded local EVM execution and optional test payments. The Hoodi escrow is deployed; the public operator ENS directory and paid-read lifecycle remain separate deployment gates. Staking is planned and unimplemented.

Use [specs/TRACKS.md](../specs/TRACKS.md) for prize criteria, [OPERATIONS.md](../specs/OPERATIONS.md) for dated evidence and [the submission packet](../specs/SUBMISSION_DRAFT.md) for prepared form text and the recording script.

## Rules

- One Ethereum Foundation prize per project. DeRPC can apply to both EF tracks below, but EF picks at most one.
- At most three partner picks in the submission; a partner with several tracks counts as one pick.
- Not targeted: Frame / alternative mempool prizes, Continuity-only prizes.

## Tracks

| Track | Fit today | Evidence in repo | Gaps | This weekend |
|---|---|---|---|---|
| **EF Best Use of Anon-RPC** ($5k, primary). [Prize page](https://ethglobal.com/events/mumbai/prizes/ethereum-foundation) | Strong integration: anonymous execution/beacon traffic with host verification. | Provider code, failure tests and [all-onion evidence](../wrapper/test/onion-availability-evidence-2026-11-06.json). | Reliable public gateway, hosted browser acceptance and live committee-transition startup; account unlinkability remains unproven. Bundle delivery and WebRTC setup remain separately disclosed. | Show a verified read, simulated corrupt-response rejection/failover, and refusal after shutdown. Record the actual path and remaining limits. |
| **EF Best CROPS App** ($3.5k) | Lead with private reads and host verification. | README [CROPS](../README.md#crops) section and the same functional evidence. | Public release path and human-narrated video; availability still depends on usable endpoints/gateways. | Record a 2–3 minute demonstration, retaining the stated trust and privacy boundaries. |
| **Best Use of ENSv2** ($7k, secondary). [Prize page](https://ethglobal.com/events/mumbai/prizes/ens) | Structural implementation exists; live qualification is not yet established. | Registrar, dedicated resolver tooling, proven discovery/local execution and actual-code fork evidence. | Real independent operator registrations and finalized discovery, restricted rotation/delisting and multi-endpoint demonstration under [M1](../specs/ENS_TOR_MILESTONE.md). | Claim completion only after those live gates pass; mock bootstrap names and fork tests do not qualify on their own. |

## Priority

1. Anon-RPC + light-client end-to-end demo.
2. Review the prepared submission copy and feedback, then record/upload the human-narrated demo.
3. Complete the required ENS milestone when operator inputs and signatures are available; keep its missing public evidence explicit. Payment activation follows the free release.
