# Payment authority for apps and agents

Payments remain disabled in the free release. This package supports test-chain sessions only;
it does not fund or deploy a session automatically.

`PaymentClient.setSpendLimit()` is a cooperative policy in one SDK instance. A caller holding
the escrow session private key can sign a voucher outside that instance, up to the funded
deposit. Giving that key to an agent gives it that authority. Changing SDK settings cannot
revoke a copied key or impose a smaller on-chain cap.

For an agent with an enforced allowance, use the existing `SponsoredPaymentCoordinator` and
`SponsoredPaymentClient` flow. The trusted application holds the escrow key; the agent receives
only a separate delegated request key. Both the client and coordinator refuse to use the escrow
key as the request key. This check catches unsafe configuration; it cannot contain a key that
has already leaked.

## Trusted coordinator

Run the coordinator outside the agent's trust boundary. The agent must not be able to read its
escrow key, change its code or ledger, or call its administration methods. A second process or
a loopback URL alone does not isolate a same-user agent with filesystem access.

The application first authenticates the test chain, escrow deployment, funded session fields,
price and session key. Set `session.budget` no higher than the confirmed deposit, provide an
independent proof/freshness verifier, and use the Linux `FileDelegationStore` from
`@derpc/payments/node`. Keep its private directory on persistent local storage.

Trusted administration creates a grant using the request key's public address:

```ts
await coordinator.grant(agentRequestAddress, 100n, grantExpiry);
```

The cap is an absolute cumulative allowance for that key, not a fresh amount each time `grant`
is called. It includes every issued authorization, even if the agent abandons a read or supplies
invalid evidence. All keys also share the fixed session budget. The coordinator reserves these
amounts durably before signing read access; payment vouchers include only completions that its
own verifier accepts. Concurrent calls cannot allocate the same remaining allowance twice.

## Agent reads

Use `SponsoredPaymentClient` with the delegated `userSigner`, the checked escrow key's public
`sessionKey` address, and an explicit coordinator transport. The supported proof-verifying reader
and runnable configuration examples are in [examples/README.md](examples/README.md#browser-or-agent).
The flow is:

1. Allocate a nonce once and persist the signed intent before sending it.
2. Obtain coordinator authorization for the exact request and authenticated block.
3. Send the authorized proof/code requests through the application's configured anonymous
   transport and verify the result in the host.
4. Send evidence to the coordinator for independent verification and a cumulative voucher.

An agent cannot raise its allowance by creating another client or adding `cap` or `budget` fields
to HTTP requests. The server exposes only `/authorize` and `/complete`; grants, revocation and
session closing are trusted administration. A delegated key's signature does not authenticate an
escrow voucher.

Keep the exact signed intent and verified evidence after an uncertain reply. Recover with
`retryBegin` or `retryComplete`, using the original nonce. Recovery of committed work does not
charge twice and remains possible after revocation or expiration. After losing local nonce
state, obtain it from trusted grant administration instead of guessing or resetting the ledger.

## Allowance top-up and revocation

An administrator may raise a key's absolute cap within the existing session budget:

```ts
await coordinator.grant(agentRequestAddress, 150n, grantExpiry);
await coordinator.revoke(agentRequestAddress);
```

For a key that already allocated `40n`, raising its cap from `100n` to `150n` leaves `110n` of
potential allowance, subject to the shared budget. It preserves its consumed exposure, nonce
and retry history across restart. `grant` also explicitly re-enables a revoked key; do not use
it as an automatic retry or background reset.

Revocation blocks new authorizations. Previously issued work may complete within its original
deadline, at most 60 seconds, against exposure already reserved. Revocation cannot retract an
existing signed voucher. Only trusted administration closes the shared session.

An on-chain deposit top-up does not change grants or the coordinator's fixed budget. Changing
`session.budget` while reopening an existing ledger is refused. To authorize spending beyond
that budget, close/refund the old session as appropriate and explicitly fund a new session with
a new budget and grants. Do not delete or roll back a ledger to make funds appear available.

## Verification and remaining limits

`test/agent-flow.test.ts` exercises real HTTP, the delegated SDK, recorded Ethereum account
proofs, durable allowance top-up/revocation and two coordinator restarts. It also demonstrates
why an escrow-key holder can bypass a local SDK cap while a delegated request key cannot sign
a valid escrow voucher. The tests use fixture keys and a fixed proof root; they make no public
transactions.

The application must still supply authenticated funding/header sources and a tested anonymous
transport. These tests do not establish a conforming anonymous Node runtime, public sponsored
reads, production readiness or an independent security review. The coordinator sees sponsored
queries and results, and paid reads remain linkable to the funding account.
