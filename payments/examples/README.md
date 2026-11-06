# App-funded reads with delegated keys

The app funds one escrow session per operator and holds its session key in the coordinator.
Browsers and agents hold separate request keys with capped, revocable grants. The flow obtains
paid wrapper access before the read and creates payment only after proof verification. The
coordinator sees sponsored queries/results; the operator sees its session and traffic. State
proofs establish correctness, not which operator supplied the evidence.

1. The browser signs `DelegatedReadIntent`, binding chain/escrow/session, user key, nonce, read
   kind, charge, expiry and the exact method/account/slot/authenticated-block request hash.
2. `SponsoredPaymentCoordinator.authorize` allocates grant and session exposure durably before
   signing the wrapper's non-spending `ReadAuthorization`. Its `readId` is the signed intent's
   EIP-712 digest. Exact retries preserve that ID, its deadline and its cost.
3. The browser uses those headers through its anonymous transport, verifies the complete proof
   locally, and sends evidence to `complete`. The sponsor independently verifies against its own
   authenticated header view and original intent before signing a cumulative voucher.
4. Vouchers accompany subsequent reads. Trusted app administration calls `prepareClose()` and
   delivers its final voucher and distinct close authorization to the wrapper for settlement.

`grants[user].spent` counts **allocated exposure**, including abandoned/invalid reads. `state.total`
counts only independently verified completions. A voucher never includes earlier unverified work.
Exposure is never returned on failure, cancellation, revoke or expiry. The default limit is four
live unfinished authorizations; expiry releases only that concurrency slot. The wrapper separately
enforces its unpaid credit window. Existing work may finish after revocation within its original
deadline, at most 60 seconds; new work is refused. Committed completions remain recoverable without
another proof or charge. Default settlement margin is 600 seconds before the refund deadline.

## Coordinator

Linux, Node 24 and util-linux `flock` are required for durable storage:

```sh
node payments/examples/coordinator.mjs /absolute/path/app-coordinator.mjs
```

The trusted application module must export these values. No RPC, funding oracle, proof verifier,
signing key or grant is substituted:

| Export | Required value |
| --- | --- |
| `session` | `{chainId, escrow, sessionId: bigint, budget: bigint, refundAfter: number, safetyMarginSeconds?: number}` for one confirmed funded test session |
| `price` | Frozen positive `bigint` per logical read, matching the wrapper |
| `stateDirectory` | Private persistent local directory supporting flock and file/directory fsync; created as `0700` |
| `sessionKeyFile` | Owner-only regular file with escrow key as 32-byte hex, mode `0600`; never give it to a browser/worker |
| `verifyFunding()` | Trusted callback returning `{closed, chainId, escrow, sessionId, sessionKey, deposit, refundAfter}` after authenticating the independently pinned chain/escrow deployment and confirmed session |
| `verifyRead(evidence, {signal,intent,authorization})` | Required independent proof/freshness verification returning `{requestHash,readHash,charge}` for the stored intent and read kind; never accept a browser success flag |
| `administer(coordinator)` | Optional trusted setup with `grant(userKey,cap,expiresAt)` and `revoke(userKey)`; regrant preserves allocated exposure/nonces |
| `onReady(coordinator)` | Optional trusted hook for later `prepareClose()` and settlement; never expose it to delegated callers |
| `port` | Optional loopback port, default `8790` |

Budget must not exceed the confirmed deposit. Hoodi, Sepolia and local test chains are allowed;
real-fund chains remain disabled. Funding checks must authenticate escrow independently of
unverified ENS records. Use the application's trusted view, with no direct RPC fallback.

[`read-evidence.ts`](read-evidence.ts) verifies balance, nonce, storage and code, derives hashes
from actual requests/results, and never accepts a state root supplied in evidence:

```js
import { createReadEvidenceVerifier } from '/absolute/path/DeRPC/payments/examples/read-evidence.ts';
// Initialize authenticatedHeaders in the application's trusted runtime before starting.
export const price = 10n;
export const verifyRead = createReadEvidenceVerifier({ headers: authenticatedHeaders, price });
```

Both `finalized()` and `assertFresh(header)` are required. This minimal verifier requires the exact
current mainnet finalized block. A header advance before completion rejects the older evidence
and retains exposure; it never substitutes an unverified root. Custom calls require a separate
bounded local-execution witness verifier binding all call inputs. The example refuses `eth_call`.

HTTP binds `127.0.0.1` and exposes only `POST /authorize` and `POST /complete`, with JSON envelopes
`{intent,signature}` and `{intent,signature,evidence}`. Responses are
`{authorization:{readId,deadline,headers}}` and `{voucher}`. The SDK encodes integers as decimal
strings. Defaults: 1 MiB bodies, four active operations and a 20-second deadline. A timed-out
verifier retains its slot until it finishes, and its late result cannot allocate new payment.
Grant/revoke/close routes are absent. Ingress and app access policy remain deployment configuration.

## Browser or agent

[`sponsored-reader.ts`](sponsored-reader.ts) supplies balance, nonce, storage and code methods.
Every RPC uses the injected `JsonRpcSend`; no global fetch or direct RPC fallback exists. Proof
and code share one authorization. The browser holds only its request key and the **address** of
the checked escrow session key:

```js
import { SponsoredPaymentClient, createSponsoredHttpTransport } from '@derpc/payments';
import { createSponsoredReader } from '/absolute/path/DeRPC/payments/examples/sponsored-reader.ts';

const client = new SponsoredPaymentClient({
  session: { chainId, escrow, sessionId, price, refundAfter },
  sessionKey: confirmedSessionKeyAddress,
  userSigner: delegatedRequestAccount,
  transport: createSponsoredHttpTransport({ url: coordinatorUrl, fetch: coordinatorAnonymousFetch }),
});
const reader = createSponsoredReader({ client, headers: authenticatedHeaders, send: anonymousRpcSend });
const result = await reader.getBalance(account, {
  nonce: nextGrantedNonce, expiresAt: grantExpiry, persistIntent: saveSignedIntentForRecovery,
});
```

The app supplies its already bootstrapped/pin-verified anonymous transport and authenticated header
source. Coordinator traffic also has an explicit fetch; the SDK never chooses a direct route.
This adapter establishes no new anonymous Node-runtime claim; the browser transport remains the
tested runtime. Block number comes directly from the authenticated header without a paid RPC.
Each operator requires its own client/session and app grant accounting.

To execute one actual read with an application-configured runtime:

```sh
node payments/examples/sponsored-read.mjs /absolute/path/app-reader.mjs
```

Export `session`, `sessionKey`, `userSigner`, `coordinatorUrl`, `coordinatorFetch`, `headers`,
`send`, `request:{method,address,slot?}` and `control:{nonce,expiresAt,persistIntent?}`. An optional
`close()` cleans up the runtime. The command neither funds a session nor invents a transport.

Allocate nonces once and retain signed intents before sending (`client.prepare` then `retryBegin`,
or reader `persistIntent`). `SponsoredRequestError.recovery` and `SponsoredReaderError.recovery`
preserve the intent; the reader retains verified `evidence` after uncertain completion responses.
Use `client.retryComplete(recovery,evidence)` after a lost reply, even after the old authorization
expired. The server recovers committed work but refuses new late completions. Do not create a new
nonce for the same logical read. Recovery data contains queries/signatures, never the app escrow
key. Authenticated grant administration must supply the current nonce after local recovery loss.

## Settlement and persistence

Only trusted app administration calls `await coordinator.prepareClose()`. It persists a terminal
state, blocks new authorizations/completions, and returns `{voucher,closeAuthorization,closeDeadline}`.
POST those values plus `close:true` to that operator's `/payments/voucher` through the configured
transport, encoding voucher `sessionId`/`amount` as decimal strings. Verified completions alone
determine payment; unverified exposure is unused deposit. A delegated browser cannot close this
shared session. An escrow-key leak can spend the deposit; a request-key leak is bounded by the
remaining grant/session exposure.

`FileDelegationStore` is exported only from `@derpc/payments/node`. One helper owns its exclusive
kernel lock and all IO. Commits write a private temporary file, fsync it, atomically rename it,
fsync the directory, then acknowledge. `close()` drains work before unlocking; killing `workerPid`
makes the parent unavailable. The store rejects decreasing counters, changed authorizations,
corruption and competing writers. Its persisted mode/version prevents the older post-proof
`CappedDelegationSigner` API from opening the same sponsored chain/escrow/session ledger.

A lost acknowledgement may leave new state committed. Stop the failed store, reopen the same
directory, and retry the exact intent. Never delete a ledger, restore an older backup or move a
funded session into an empty directory: historical exposure cannot be recovered from the deposit.
Retire/refund the session if its ledger is lost. Back up a stopped coordinator's whole directory
and retain a persistent local volume. Network-filesystem behavior is not claimed; host/storage
administrators remain trusted and can replace code or historical state.

Run `pnpm --filter @derpc/payments test` and the repository's contract tests. Tests cover recorded
mainnet proofs, real HTTP, competing processes, crashes before/after signatures, out-of-order
completion, restart/revocation and real local-chain wrapper settlement. Recorded roots are fixed
test anchors. These results do not establish a public deployment or fresh anonymous sponsored
traffic; those require the application's configured live environment.
