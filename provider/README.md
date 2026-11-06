# `@derpc/provider`

Private, verified Ethereum reads. Every value comes from an `eth_getProof` answer checked against a
light-client-verified finalized state root; every request goes through the Anon-RPC worker. There is
no direct RPC fallback.

The package is a read-only EIP-1193 provider plus a viem transport. It holds no keys and sends no
transactions.

## Install and initialize

```ts
import { createDeRPC, MAINNET_OPERATORS } from "@derpc/provider";
import { derpcTransport } from "@derpc/provider/viem";
import { createPublicClient } from "viem";
import { mainnet } from "viem/chains";

// The operators your user picked. DeRPC never chooses on their behalf.
const selected = new Set(["mevblocker.derpc.eth", "blockrazor.derpc.eth"]);
const operators = MAINNET_OPERATORS.filter((operator) => selected.has(operator.ens));

const derpc = createDeRPC({
  operators,
  gateways: import.meta.env.VITE_TOR_GATEWAYS?.split(",").filter(Boolean),
});

const client = createPublicClient({ chain: mainnet, transport: derpcTransport(derpc) });

await derpc.ready; // worker booted and a fresh finalized header verified
const balance = await client.getBalance({ address, blockTag: "finalized" });
```

`createDeRPC()` returns immediately. Worker startup and light-client sync continue in the background;
reads wait for them. `ready` resolves once the worker is running and the light client has verified a
fresh finalized header. It rejects permanently if either step fails.

Without operators, nothing is read. Call `derpc.setOperators([...])` after the user makes a choice.
When operators are present, the first read also proves the pinned worker hash on-chain; later reads
wait for that check, and a proven mismatch is final.

`close()` stops the worker. Pending and later reads fail with `4900`; there is no reopening and no
direct fallback.

## Supported methods

| Method | Finalized block argument |
| --- | --- |
| `eth_chainId` | none |
| `net_version` | none |
| `eth_accounts` | none; always returns `[]` (read-only) |
| `eth_blockNumber` | none; returns the verified finalized block |
| `eth_getBalance` | optional; defaults to the verified finalized block |
| `eth_getTransactionCount` | optional; defaults to the verified finalized block |
| `eth_getCode` | optional; defaults to the verified finalized block |
| `eth_getStorageAt` | optional; defaults to the verified finalized block |

`eth_chainId`, `net_version`, `eth_accounts` and `eth_blockNumber` are free reads. The four state
methods prove their result against the verified finalized state root.

### Finalized-block behavior

Pass `"finalized"`, or the exact number or hash of the current verified finalized header. Omitting the
block argument also means the verified finalized block.

DeRPC refuses `"latest"`, `"earliest"`, `"pending"`, `"safe"` and any other block it cannot prove with
`-32602`. A selector that names both `blockHash` and `blockNumber` is refused too.

The reader is pinned to one verified header per read. If the finalized head moves while a read is in
flight, the retry stays on the block the read started at; the header is rechecked for freshness before
the value is returned.

### Unsupported methods

`eth_call`, logs, filters, transactions and anything else outside the table are refused with `4200`.
They are never forwarded to an operator. `eth_call` has its own message because returning an
unverified execution result would defeat the proofs; proving it needs local execution against proven
state.

## Errors

Errors are EIP-1193 `ProviderRpcError`s (`code`, `message`, optional `data.reason`). Branch on `code`;
use `data.reason` when you need the DeRPC error name.

| Code | Meaning | `data.reason` examples |
| --- | --- | --- |
| `4900` | Disconnected: worker closed/failed, or the anonymity network is unavailable | `TransportUnavailableError`, `NetworkUnavailableError` |
| `-32002` | Refused for safety | `NoOperatorsChosenError`, `PoolExhaustedError`, `StaleHeaderError`, `StaleCheckpointError`, `HeaderSourceNotReadyError`, `WorkerPinMismatchError`, `WorkerPinChainError`, `ProofVerificationError` |
| `-32602` | Invalid params, or a block selector DeRPC cannot prove | — |
| `4200` | Method not supported (including `eth_call`) | — |
| `-32603` | Unexpected internal error | — |

A network outage does not bench the chosen operators: when every attempt dies on the anonymity
network, the provider reports `NetworkUnavailableError` instead of cooling down endpoints that never
got a usable circuit. A later successful read clears it.

viem wraps provider errors. Use `error.walk()` to reach the underlying `code` and `message` (see the
[integrator example](../frontend/src/example.ts)).

## Status and events

`derpc.status()` returns a snapshot:

| Field | Meaning |
| --- | --- |
| `transport.state` | `booting`, `ready`, `failed` or `closed` |
| `network.state` | `ok` or `unavailable`; the last observed anonymity-network state |
| `lightClient.state` | `waiting`, `syncing`, `verified`, `stale` or `failed`; includes the verified header when available |
| `pin.state` | `waiting-for-operators`, `waiting-for-light-client`, `checking`, `verified`, `mismatch` or `failed` |
| `operators` | Per-endpoint selection state: `eligible`, `cooldown` or `excluded` |
| `worker`, `checkpoint`, `chainId` | The pinned worker, trusted checkpoint and chain |

The provider emits `connect` after the light client verifies and `disconnect` on worker failure or
`close()`. The `onStatus` and `onPoolEvent` callbacks passed to `createDeRPC()` are app callbacks:
exceptions in them are logged and cannot change DeRPC's state or fail a read.

## Cancellation and timeouts

The EIP-1193 `request()` surface has no per-call `AbortSignal`. Each read is bounded instead:

- the pool has a total budget (30 s by default) and an attempt timeout (20 s by default);
- an attempt that exceeds the budget is aborted, and a late response is rejected;
- `close()` makes pending and later reads fail with `4900`.

## viem

`derpcTransport(derpc)` returns a viem `CustomTransport` with retries disabled: the pool already
retries on other chosen operators, and a second layer would only send the query to more operators.
Always pass `blockTag: "finalized"` (or the exact verified block); viem defaults to `"latest"`, which
DeRPC refuses.

## Example

The smallest browser integration is [`frontend/src/example.ts`](../frontend/src/example.ts), served at
`frontend/example.html`. It imports only `@derpc/provider` and `@derpc/provider/viem`, nothing from the
demo, performs a proven balance read, and shows the refusal for an unsupported `eth_call`.
