# Prize tracks

Which ETHGlobal Mumbai prizes DeRPC targets, and what the repo supports today. Claims here must match the README and the code.

What exists today: a browser library (`createDeRPC` from `@derpc/provider`, viem transport `derpcTransport` from `@derpc/provider/viem`) that boots the pinned tor-js 0.4.4 Anon-RPC worker, syncs the Lodestar 1.43.0 light client through it, proves the worker pin on-chain, and serves account/storage/code proofs from a pool of five curated public mainnet endpoints (`MAINNET_OPERATORS`) with local exclusion and bounded failover. Operator ENS names are mock labels (`ENS_NAMES_ARE_MOCK`). There is no staking, payment or on-chain operator registry.

## Rules

- One Ethereum Foundation prize per project. DeRPC can apply to both EF tracks below, but EF picks at most one.
- At most three partner prizes in the submission.
- Not targeted: Frame / alternative mempool prizes, Continuity-only prizes.

## Tracks

| Track | Fit today | Evidence in repo | Gaps | This weekend |
|---|---|---|---|---|
| **EF Best Use of Anon-RPC** ($5k, primary). [Prize page](https://ethglobal.com/events/mumbai/prizes/ethereum-foundation) | Strong. All RPC and beacon reads go through Anon-RPC by default with no direct fallback, and every answer is checked against a light client, one of the suggested ideas. | `provider/src/transport/anon-transport.ts`, `provider/src/light-client/`, `provider/src/pool/`, `frontend/src/main.ts`, README "What works" and request table | P2/P3 QA sign-off, total-deadline enforcement, poll recovery, isolation keys unproven. Intentional direct connections to disclose: jsDelivr worker bundle download, WebRTC link to the Tor gateway. | Make the end-to-end demo solid (verified read, corrupt response excluded, worker closed fails closed). Record the video. Show the share of traffic through Anon-RPC. |
| **EF Best CROPS App** ($3.5k) | Good. Lead with P (private) and S (secure). | README "CROPS" section | Same QA gaps; C depends on public endpoints and a gateway. | Keep the CROPS section honest; apply, knowing EF awards one prize per project. |
| **Best Use of ENSv2** ($7k, secondary). [Prize page](https://ethglobal.com/events/mumbai/prizes/ens) | Weak today. ENS is cosmetic: operators are curated and names are mock. | `MAINNET_OPERATORS`, `ENS_NAMES_ARE_MOCK` in `provider/src/config/mainnet.ts`; README stretch goal | Needs ENS to be structural and working on mainnet or Sepolia: an operator registry under `derpc.eth` read through Anon-RPC and proven by the light client. | Only if the core demo is done: real subnames and records, read and proven by DeRPC. Otherwise list as roadmap, not as a claim. |

## Priority

1. Anon-RPC + light-client end-to-end demo.
2. Submission copy for Anon-RPC and CROPS.
3. ENSv2 only if there is real time for subnames and records.
