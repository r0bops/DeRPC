# @derpc/provider

Private, verified Ethereum reads for apps and wallets. Application reads go through Anon-RPC (the tor-js worker), within the user's manual selection or explicitly authorized automatic pool. Supported read values are authenticated against the light client's verified state before they return. Nothing falls back to a direct connection. ENS discovery has separate verification labels and public capability probes described below.

This is a limited read provider for Ethereum mainnet, not a full wallet RPC.

## Use it with viem

```ts
import { createDeRPC, MAINNET_OPERATORS } from "@derpc/provider";
import { derpcTransport } from "@derpc/provider/viem";
import { createPublicClient } from "viem";
import { mainnet } from "viem/chains";

const operators = MAINNET_OPERATORS.filter((o) => userChoice.includes(o.ens)); // manual selection
const derpc = createDeRPC({ operators, gateways: ["<your tor-js gateway>"] });
const client = createPublicClient({ chain: mainnet, transport: derpcTransport(derpc) });

const balance = await client.getBalance({ address, blockTag: "finalized" });
```

A complete page is in `frontend/src/example.ts`. Pass `blockTag: "finalized"` on every read: viem defaults to `"latest"`, which DeRPC can't prove and refuses.

Without viem, use `derpc.provider`, a standard EIP-1193 provider (`request`, `on`, `removeListener`).

## Supported methods

| Method | Answer |
|---|---|
| `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`, `eth_getStorageAt` | Proven at the verified finalized block, through one of the user's operators |
| `eth_blockNumber` | The verified finalized block number (not the chain head). No operator is asked. |
| `eth_chainId`, `net_version` | Mainnet (`0x1`, `"1"`), answered locally |
| `eth_accounts` | `[]`; the read provider exposes no wallet or payment signing key |

By default, every other method is refused with code `4200`, including `eth_call`, `eth_getLogs`, `eth_estimateGas`, block and transaction lookups, and anything that writes. They aren't forwarded: their raw answers carry no proof. The explicit local-execution option below can enable a bounded, verified `eth_call`. ERC-20 balances can also be proven from storage: use `derpc.reader.getTokenBalance(token, holder)`, or `eth_getStorageAt` with the known mapping slot (`mappingSlot` is exported).

## Verified local execution

```ts
const derpc = createDeRPC({ operators, gateways, verifiedCalls: true });
const result = await derpc.verifiedCall({ to: contract, data: calldata, signal });
// result.value is return data; result.block is the authenticated finalized block.
```

`verifiedCalls: true` enables only this explicit API. To opt EIP-1193 `eth_call` and viem `readContract()` into the same local executor, pass `verifiedCalls: { eip1193: true }` and still request `finalized`. The executor runs in the host and fetches only proven accounts, storage and code through the selected operator. It never forwards an unverified remote `eth_call` for an application read. Each call has an isolated simulation; it submits no transaction and persists no simulated writes.

The supported input is `to`, optional `data`, `from`, `gas` and `signal`; value transfers and transaction overrides are not supported. Defaults bound gas to 1,000,000, steps to 100,000, accounts to 24, storage slots to 64, remote round trips to 128, memory to 4 MiB and execution time to 60 seconds. The pool uses that same call deadline, including retries. Configure `verifiedCalls: { limits: { ... } }` to change executor limits. The executor refuses unsupported forks/context, `BLOCKHASH`, `BLOBBASEFEE`, and CCIP-Read/off-chain resolution. A limit failure or revert returns no verified value and earns no payment. This is an experimental bounded executor, not a claim of compatibility with every contract.

The same explicit option enables fully on-chain ENS resolution:

```ts
const resolved = await derpc.resolveEns({
  name: "vitalik.eth",
  record: { type: "address" },
});
// resolved.normalizedName, resolver, value and authenticated block
```

Profiles include Ethereum addresses, `{ type: "text", key }`, `{ type: "contenthash" }` and `{ type: "coinAddress", coinType: 60n }`. One local EVM call executes the pinned mainnet Universal Resolver V2 path against proven state, including the hierarchy and selected resolver. ENSIP-15 normalization, name/data/output bounds and cancellation apply. Empty proven records remain empty; contenthash bytes are returned without fetching content. Off-chain resolution and work beyond the executor's limits remain refused. The state accesses can reveal which names/records are being read to the endpoint; anonymous transport does not hide query contents.

Advanced integrations can import `resolveVerifiedEns` from `@derpc/provider/ens` and supply their authenticated header source plus verified executor. This optional subpath requires Viem; the core executor does not eagerly import ENS normalization or ABI helpers. The resolver address and source revision are recorded in the module; proof verification authenticates its actual code and state at the returned block.

## Block parameter

DeRPC proves state at one block: the light client's verified finalized block, usually 13–19 minutes behind the head.

- Accepted: `"finalized"`, that block's number (hex), `{ blockNumber }` or `{ blockHash }` for that block (EIP-1898), or no block parameter.
- Refused with `-32602`: `"latest"`, `"safe"`, `"pending"`, `"earliest"` and any other block. If the verified block moves on while a read runs, a read pinned to the old number is refused rather than answered from a different block.

## Initialization

`createDeRPC` returns at once. In the background it boots the pinned worker, syncs the light client from the pinned checkpoint through the worker, and, once operators are chosen, proves the specifier's on-chain `workerHash` (storage slot 1) equals the pin. That proof goes through the user's operators, like every other read.

- `derpc.ready` resolves when the worker runs and the light client has verified a fresh header. It rejects for good if either fails.
- Requests made before that wait for it. Reads also wait for the worker-pin proof.
- With no operators chosen, reads fail at once (`NoOperatorsChosenError`). Call `derpc.setOperators(list)` when the user chooses or changes their choice. Exclusions from the session carry over.
- `derpc.status()` and the `onStatus` option report the worker, light client, worker pin and each operator's state. Use them for a progress or status screen. `onPoolEvent` reports each attempt, rejection and failover.
- `derpc.status().lightClient.poll` reports the worst consecutive failure count and its error across optimistic and finality polling. Only a success for the affected kind clears its failures; a working optimistic endpoint cannot hide failing finality updates.

`beaconUrl` and `beaconUrls` configure startup candidates; initially chosen operators' `beaconUrl` values also contribute. They are all reached through the worker. Replacing the execution selection later does not replace the already-running light client's bootstrap configuration.

## Automatic selection

Automatic routing requires an explicit `selection`. Without it, the existing manual behavior remains: the application supplies the user's chosen operators, and no operators means no reads.

```ts
const derpc = createDeRPC({
  chainId: 1,
  operators: MAINNET_OPERATORS, // five configured bootstrap entries; ENS names are still mock
  selection: "balanced",
  // allowedOperators omitted: all eligible free candidates in this source
  gateways,
  verifiedCalls: true, // needed for a later proven ENS directory refresh
});

derpc.setRouting({ selection: "fastest", allowedOperators: ["drpc.derpc.eth"] });
derpc.setRouting({ selection: "reliable", allowedOperators: [] }); // no permitted operators
derpc.setRouting({ selection: "balanced" }); // all eligible candidates again
```

`allowedOperators` matches exact operator group IDs or ENS names; legacy single-endpoint IDs remain supported. A plural node ID such as `alice.derpc.eth#node-a` is not an operator allowlist entry. A nonempty list restricts candidates; it cannot introduce an endpoint that is absent from the source. An empty list never means “all.” `setRouting(policy, operators)` can atomically replace the policy and explicit candidate source. `setOperators(list)` replaces that explicit source under the current policy. Return to `selection: "manual"` with the desired list to use personal nodes or the separately enabled payment flow.

| Mode | Preference for a new account or after failover |
|---|---|
| `balanced` | Recent verified success and observed latency |
| `fastest` | Shorter recent successful, verified attempts |
| `reliable` | Higher recent verified success rate |

These are local preferences, not global rankings. Unknown entries have no measured health; exploration allows new candidates to be tried without broadcasting each query. Existing account affinity takes precedence over ranking. Each read still uses bounded sequential failover, expiry checks and local invalid-proof exclusion. Invalid or unverified answers do not earn a fast-response score; cancellations and client-side stoppages do not count as operator failures. Paid listings, personal credentials and simulated corruption entries are excluded from automatic routing, and automatic requests never activate payment hooks.

Each endpoint retains at most 32 completed observations from the last five minutes. Operator ranking uses at most the newest 32 actual observations across its endpoints in that same window. Selection chooses an operator first, then an eligible endpoint; publishing more URLs does not multiply an operator's chance. A new assignment explores uniformly across operators 10% of the time; when all candidates are unknown, operator selection is uniform. Fastest uses mean successful verified-attempt duration. Reliable uses `(successes + 1) / (attempts + 2)`. Balanced combines that rate with latency relative to the observed candidate median. Measurements include actual request work and network conditions, so they are not controlled benchmarks. Manual mode retains its priority tiers; automatic categories consider every eligible tier.

The same bounded ranking and exploration rule chooses a node within the selected operator. Manual priority first determines eligible operator groups, then the preferred nodes within that group. Per-account affinity retains the serving operator and endpoint. If that endpoint fails, another eligible endpoint of the same operator is preferred before another authorized operator. All attempts still share the existing retry count and time budget; multiple nodes do not permit query racing or unbounded retries. Invalid-proof exclusion and cooldown apply to the individual endpoint. Expiry and delisting remove the operator's whole group.

`chainId` currently accepts only Ethereum mainnet (`1`). It configures the provider, not an extra Ethereum JSON-RPC parameter. The provider still refuses unsupported methods and block tags. A single `derpc.eth` directory is supported through the verified refresh below; the name alone does not supply missing registrar deployment pins. There is no central redirect service.

## ENS discovery and operator identity

The built-in `MAINNET_OPERATORS` list is curated and its `.derpc.eth` names remain mock identifiers until actually registered. To refresh a deployed ENSv2 directory through a previously chosen bootstrap operator:

```ts
const directory = await derpc.refreshDirectory({
  ethRegistry: deployedEthRegistry,
  registrar: {
    address: deployedRegistrar,
    codeHash: verifiedRegistrarRuntimeHash,
    registry: deployedSubregistry,
  },
  verifiedRecords: true,
  signal,
});
```

Use addresses and the actual immutable-bearing runtime hash from a checked deployment manifest. `verifiedRecords: true` requires `verifiedCalls` to be enabled. The returned directory carries independent `listVerification` and `recordVerification` fields, a verified block, accepted operators and rejection reasons. Refresh reads the complete list and probes each candidate's identity plus the same public worker-pin proof through the worker; no user-account query is sent to those candidates. In manual mode it retains previously chosen ENS entries that remain valid and preserves personal nodes; new entries require explicit selection. In automatic mode both list and record verification are mandatory before the full eligible free directory replaces the source under the current allowlist. Failed or superseded refreshes cannot expand the active pool. An empty verified directory closes user reads; it does not silently restore the bootstrap roster.

In manual mode, when the chosen bootstrap operator has a funded session, proven discovery authorizes each local resolver call and the registrar scan separately. A full refresh can therefore contain multiple paid logical reads. Automatic routing remains free-only. The fixed candidate capability probes and worker-pin bootstrap proof remain unpaid.

Without a registrar pin or proven local ENS execution, the list is unverified discovery. A pinned registrar authenticates its fixed-layout list and payees; it does not by itself authenticate parent pointers or resolver records. With `verifiedRecords`, hierarchy and record calls execute locally against proven state, including a parent index if one exists. The deployment planner preserves the existing parent resolver and publishes no parent index, so its deployment uses the registrar pin. Without local execution, discovery uses anonymous raw ENS calls and labels the records unverified. This requires a chosen bootstrap endpoint that permits those calls; the filtering wrapper refuses raw `eth_call`. No mode follows an off-chain resolver URL. A proven payee alone does not authenticate the payment contract or all payment terms.

An operator can set `wrapperIdentity: { signer }`, with its `ens` name, to require a matching `/.well-known/derpc.json` before reads. The document binds the reached onion endpoint to its advertised name, signer and mainnet service; it does not upgrade an unverified ENS answer into a proof. Endpoint changes require a fresh check.

An ENS operator can publish a bounded `derpc.endpoints` record:

```json
{"version":1,"endpoints":[{"id":"node-a","url":"https://a.example.org/rpc","beaconUrl":"https://a.example.org/"},{"id":"node-b","url":"https://b.example.org/rpc","beaconUrl":"https://b.example.org/"}]}
```

The shared `parseOperatorEndpoints` and `serializeOperatorEndpoints` helpers enforce 1–8 entries, a 4096-byte UTF-8 record, stable lowercase ASCII IDs of 1–31 characters, unique canonical RPC URLs and HTTPS/v3-onion URL checks. Public plural URLs cannot contain credentials, query strings or fragments. Common signer/capability/gateway records apply to all nodes. Each plural wrapper must also echo its exact `endpointId` in the identity document. A failed node probe does not invalidate a healthy sibling; an invalid plural record rejects the operator. An empty plural record allows legacy singular `derpc.endpoint`/`derpc.beacon` records, while an invalid nonempty plural record never falls back to them.

Discovery returns a flat list of endpoints. Plural entries have `operatorId: "alice.derpc.eth"`, `endpointId: "node-a"` and `id: "alice.derpc.eth#node-a"`; legacy global IDs stay unchanged. Use `operatorKey(entry)` when grouping choices or counting operators. Changing a URL while retaining a node ID rotates that endpoint and invalidates its previous identity/health evidence. When every node rotates, operator affinity survives only if the earlier and replacement pools share proven ENS owner and signer bindings; caller-supplied owner claims cannot create that continuity. Plural records and explicit multi-node groups are free-only; funded sessions retain their original singular endpoint and settlement destination.

The directory remains curated: the parent-name owner can repoint the subregistry and the registrar curator admits or removes listings. There is no staking or slashing. See [the operations checklist](../specs/OPERATIONS.md#ens-rollout-and-trust) for deployment and verification gates.

Directory authorization describes the last verified finalized snapshot and its listing expiries. Later on-chain changes become known on a subsequent verified refresh; a connected client does not receive instantaneous revocation knowledge.

Proven snapshots are usable for at most ten minutes after first acceptance, capped at 30 minutes after their authenticated block timestamp. `status().routing?.directorySnapshot` reports the block/hash, `verifiedAt`, `expiresAt`, `state` and whether current reads depend on it (`requiredForReads`). Expiry or a backwards clock stops dependent reads, including cached returns, without blaming an endpoint. A failed refresh, a category change or re-proving the same block cannot extend this deadline. Reusing a previously known ENS endpoint under different local metadata does not remove its directory requirement.

Refresh against a newer finalized block to recover. An explicit refresh can use retained, free administrative bootstrap candidates under the current allowlist; that pool never becomes a user-read fallback. An empty automatic allowlist also forbids those administrative candidates. A scan begun just before the old snapshot expires may be interrupted; retry explicitly after expiry to use the administrative recovery path. Alternatively remove the ENS-dependent entries: independent explicit/personal-only routes remain usable. Existing funded sessions can still settle after directory expiry.

Record transport failures or incomplete local execution abort the entire scan. A proven contract revert or invalid authenticated record may reject an individual candidate; endpoint reachability is an independent availability observation. Declared and known gateway/RPC ownership conflicts are rejected before candidate identity/proof probes.

## Personal nodes and gateway separation

```ts
const ownNode = {
  id: "my-node", priority: -1, operator: "My own node",
  url: "http://<private-v3-address>.onion/rpc",
  personalToken: token,
};
derpc.setRouting({ selection: "manual" }, [ownNode, ...chosenFallbacks]);
```

Personal endpoints require an unpublished v3 onion and a 64-character lowercase hex token. Keep the token in memory; never put it in ENS, logs, browser storage or a URL. Personal nodes are unpaid, remain proof-verified and can fall back to the other chosen operators. To use their beacon route at startup, provide `beaconUrl` on the same private origin in the initial options.

Declare each operator's `gateways` and supply independently known `gatewayOwners`, mapping KPS gateway addresses to operator identities. DeRPC validates chosen operators before worker startup and on later selection changes, refusing a known same-operator gateway/RPC pairing. Undisclosed ownership cannot be inferred from addresses; several URLs alone do not establish independence.

## Test-payment sessions

```ts
import { PaymentClient } from "@derpc/payments";

const payments = new PaymentClient({ onChange: updatePaymentDisplay });
const derpc = createDeRPC({ operators, gateways, payments });
```

The application separately opens an escrow session through the payer's wallet, verifies its receipt and fields, then calls `payments.addSession(...)` with the operator ID, session ID, payer, payee, disposable signer, confirmed deposit, price, refund deadline, payment chain ID and escrow address. Use one session per operator. Call `derpc.registerPaymentOperator(operator)` after attaching the funded session to retain its settlement endpoint even if the user deselected it while the wallet transaction was pending. This does not select it for reads and refuses a different endpoint for an already pinned session. The mutable manager can accept newly funded sessions without restarting DeRPC. Only the supported test-chain IDs are accepted; see [the contract guide](../contracts/README.md#test-payment-deployment).

For a paid read, the provider reserves credit before querying and authorizes a cumulative voucher only after the entire proof/execution result and its freshness pass. Invalid proofs, aborted work and local cache hits do not increment the total. An operator failover requires that operator's own funded session. The client stops new reads before the refund safety margin, freezes the session price and never silently raises its spending cap after a top-up. After a confirmed top-up, use `updateDeposit`; changing the SDK cap requires a separate `setSpendLimit` call.

After outstanding reads finish, flush the final voucher through the worker:

```ts
await derpc.settlePayment(operatorId);                 // Deliver the latest voucher.
await derpc.settlePayment(operatorId, { close: true }); // Also authorize closing.
```

The returned wrapper acknowledgment is not a verified payment-chain receipt. Confirm the closing payout and refund on the configured test chain before removing the session. `derpc.close()` stops transport; it does not settle funds, so flush first. Retain the wallet's ability to claim an expired unclosed session directly from escrow.

Paid queries are linkable to the paying account. Wallet deposits, top-ups and refunds use the wallet's payment RPC outside the read worker. The disposable escrow signer lives in host memory, never in the worker or `eth_accounts`; reload loses it. This SDK supports fresh sessions, not restoration without signed-total reconciliation. Its spending limit protects cooperative use; a compromised escrow key can sign up to the full deposit. App-sponsored delegation keeps that key in a trusted app service and gives browsers capped request keys instead; [the operations checklist](../specs/OPERATIONS.md#payment-rollout) describes the durable-store and verification requirements.

For a server coordinator, `@derpc/payments/node` provides the Linux/Node 24 durable store and bounded loopback authorization/completion service. `SponsoredPaymentClient` obtains read access with only a delegated request key; the app signs payment after independently verifying the evidence. The [sponsored reader examples](../payments/examples/README.md) cover balance, nonce, storage and code with explicitly injected anonymous transports. The [runnable coordinator entrypoint](../specs/OPERATIONS.md#app-coordinator-example) requires actual funding and proof-verification callbacks and keeps grant/revoke administration in the application. It does not establish a supported anonymous Node read runtime.

## How a read is routed

- Each account's reads retain their assigned operator while it remains eligible, limiting disclosure to other operators. Failover and explicit changes can expose that account to another operator. Each account also gets its own isolation key; whether separate keys give separate Tor circuits depends on the worker.
- An answer that fails proof verification excludes that operator for the session. This is local evidence only: the worker could also have altered the answer.
- A timeout, rate limit or Tor exit failure rests the operator for 60 s. The read moves to another chosen operator on a fresh circuit. When none is left, it gives a resting one another try on a fresh circuit. An excluded operator is never retried.
- Ordinary proof/code reads allow at most 3 attempts and 30 s total, with a 20 s fetch timeout. Verified local calls use their executor's configured total deadline (60 s by default); directory refresh defaults to 120 s for the whole scan. Verified basic-read results are cached per verified block, on the device.

## Cancellation

EIP-1193 and the basic account reader have no per-request cancellation parameter. `verifiedCall`, `refreshDirectory` and `settlePayment` accept an `AbortSignal`. Each RPC fetch has one deadline covering response headers and body; beacon fetches use the same rule. Bodies are capped at 16 MiB and streams are cancelled on timeout, abort or oversize responses. The pool also enforces its total deadline during an attempt. Replacing the operator selection cancels work using the old pool. `derpc.close()` aborts pending operations and stops the worker; later state reads fail with `4900`, cached values included. No shutdown or retry path opens a direct RPC connection.

## Errors

Errors are `ProviderRpcError` with an EIP-1193 `code`, and `data.reason` naming the DeRPC error. Branch on those, not on the message.

| Code | When | `data.reason` |
|---|---|---|
| `4200` | The method can't be proven, so it is refused | — |
| `4900` | The anonymous network is gone (worker failed to start, failed, or closed) | `TransportUnavailableError` |
| `-32602` | Bad address or slot, or a block DeRPC can't prove | — |
| `-32002` | DeRPC refused for safety, or couldn't get a proven answer | `NoOperatorsChosenError`, `PoolExhaustedError`, `WorkerPinMismatchError`, `StaleHeaderError`, `StaleCheckpointError`, … |
| `-32603` | Anything unexpected | the error's name |

`derpcTransport` turns viem's retries off: the pool already retries within its limits, and another layer would only send the same query to more operators.

## Testing and demos

`simulatedLyingOperator(operator)` wraps one of the user's operators: it sends the real request through the worker, then inflates the balances it returns. DeRPC rejects it and excludes it locally. Use it only to show or test that behaviour.
