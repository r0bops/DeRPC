# DeRPC contracts

Experimental contracts for operator discovery and test payments. Run the local checks before preparing a deployment:

```sh
pnpm --filter @derpc/contracts compile
pnpm --filter @derpc/contracts test
```

The compiler is pinned to Solidity 0.8.30, with optimizer runs 200 and the Shanghai EVM target. Generated artifacts, ABI and storage layout are written to `contracts/out/` and ignored by Git. The tests use an in-memory local chain; a passing test is not a public deployment or an independent audit.

The website and CLI share browser-safe ENS validation, planning and receipt checks in `lib/`; only Node adapters compile contracts or read/write local evidence. The [website wallet guide](../web/README.md#operator-wallet-configuration) covers deployment-gated registration, renewal, endpoint updates and browser recovery. Initial namespace setup still uses the owner-authorized deployment workflow below.

## QueryEscrow

`QueryEscrow` escrows the chain's native asset. It has no owner, upgrade path or project token. Each session names a payer, operator and disposable signing key. All payment demonstrations use test funds pending the [real-fund release gates](../specs/OPERATIONS.md#real-fund-decision-record-62).

| Function | Effect |
| --- | --- |
| `open(operator, sessionKey)` payable | Deposit once and create a unique session. The refund deadline is 24 hours after opening. |
| `topUp(sessionId)` payable | The payer increases the deposit before expiry; the deadline does not move. |
| `close(sessionId, amount, signature)` | Before expiry, only the session's operator may settle the signed cumulative amount. The remainder returns to the payer. |
| `refund(sessionId)` | At or after expiry, only the payer may reclaim an unclosed session. |
| `withdraw(recipient)` | Recover a deferred payout if the original recipient rejected the transfer. |
| `voucherDigest(sessionId, amount)` | Return the contract's EIP-712 digest for comparison with a signer. |

The typed-data domain is `DeRPC Query Escrow`, version `1`, the payment chain ID and the deployed escrow address. `Voucher(uint256 sessionId,uint256 amount)` binds the unique session and total. A signature for another chain, contract, session or amount is invalid. Reusing a session key does not reuse a session ID. The contract limits claims to the deposit and refuses a second close or a close after the refund deadline.

The client, not the escrow, establishes that a query was correct: it signs only after host verification succeeds. An operator can claim a signed total without submitting per-read proofs to the contract. The client must therefore protect its signer, enforce spending caps and flush the final voucher. The wrapper must retain the highest accepted voucher durably and settle before its safety margin. A recipient that rejects its transfer receives a deferred withdrawal balance, so it cannot prevent the other party's settlement.

An ENS payee record is unproven unless it is authenticated through the pinned registrar or verified records. A lying RPC can substitute a payee in unverified discovery, including in a test flow; label that payee unproven and do not use it for real funds. A proven payee alone does not authenticate the payment contract or all payment terms. Current payment tooling is restricted to test chains.

Paid queries are linkable to the paying account. Wallet deposits, top-ups and refunds and the operator's settlement transaction use their configured payment-chain connection outside the read worker. The worker receives request credentials/vouchers, never the private session signing key.

## OperatorRegistrar

`OperatorRegistrar` provides open, free registration in front of an ENSv2 UserRegistry. The caller must be the address receiving the operator name; neither an approval bot nor the parent owner signs on the operator's behalf. It accepts lowercase ASCII labels of 1–31 bytes, with internal hyphens allowed, for `<operator>.derpc.eth`. A label with hyphens in both the third and fourth places, such as `ab--cd` or `xn--name`, is refused. Leases last at most 30 days. The proof list holds at most 128 entries. `registerInSlot(slot, …)` can reuse an expired slot or a delisted slot for a different available name. A still-leased ENS name cannot be overwritten.

Unblocked operators admit themselves. A listed operator can extend its own running lease. Only the curator can use `renew` after expiry; an unblocked operator may instead re-register its expired, available name. A removed entry cannot renew or bypass its registration blocks. Operators may update their own proven payee while active. Names have a zero role bitmap: no transfer, resolver-change or subregistry privilege is granted to the token owner. Each operator controls its dedicated resolver separately; its endpoint hot key has only the selected text-key permission.

`remove(index, operator, packedLabel)` is curator-only. It delists the expected entry and blocks both the operator address and label hash from new registration. The `bytes32` label is right-padded ASCII, not its hash. `reinstate(index, operator, packedLabel)` restores that exact entry and clears those two blocks; the lease is unchanged. Binding both identity fields prevents stale moderation from affecting a reused slot, including one with the same owner. Separate curator-only `setOperatorBlocked(address,bool)` and `setLabelBlocked(bytes32,bool)` control future admission; the latter takes `keccak256(bytes(label))`. They do not alter existing entries. Removing one shared-owner entry leaves its active siblings unchanged, but blocks that address from registering new names until explicitly restored.

Delisting does not burn the ENS token. The old name remains leased even if its proof-list slot is reused; its persistent name block survives that reuse. Discovery consults registrar membership, not token existence alone. Registration callbacks cannot reenter registration, lease, payee or moderation mutations.

Known limits of the registrar:

- **Free admission has no Sybil or squatting defence.** New wallets can occupy all 128 slots and renew them. The curator can remove entries to recover capacity, but new identities can return. A name does not prove an independent or honest service.
- **No key rotation during a lease.** After compromise, the curator removes the entry. Once the ENS lease expires, the curator can unblock the label and the replacement operator can register it from its own wallet. The compromised address can remain blocked.
- **The curator is fixed at deployment.** Changing it needs a new registrar, and every client then needs the new address and runtime hash.
- **The parent lease is not checked on-chain.** The registrar does not read `derpc.eth`'s own expiry. The planner and lifecycle tool refuse a lease beyond it, and ENS discovery uses the earlier of the two.
- **Renew only through the registrar.** Renewing an operator name directly in the ENS registry leaves the registrar's copy of the expiry behind, and the label can then not be reused until the ENS lease ends.

### Proof layout

The deployed registrar's runtime hash is a client trust pin. Immutables such as the curator and registry affect that runtime, so compute the hash from the actual verified deployment, not from unresolved compiler bytecode.

| Location | Value |
| --- | --- |
| Storage slot `0` | `operators.length` |
| `keccak256(uint256(0)) + 3 × index` | ASCII label in `bytes32`, right-padded with zero bytes |
| Next slot, bits 0–159 | Operator address |
| Same slot, bits 160–223 | Effective listing expiry |
| Same slot, bits 224–231 | Active flag |
| Third slot, bits 0–159 | Payee address |

`provider/src/discovery/registrar.ts` proves the array against one authenticated finalized state root and checks the pinned code hash. It does not infer the storage layout of an upgradeable ENS resolver. Proving a registrar list does not itself prove that ENS currently points to that registrar's registry; parent pointers and resolver records need their own authenticated resolution.

## Deployment records

Mainnet ENS and the payment testnet are separate deployments. Keep the chain ID, source/compiler settings, transaction receipts, resulting addresses, runtime hashes and complete ENS roles in the deployment record. Public addresses may be checked in; private keys, tokens and funded test-wallet recovery phrases must not be.

### ENSv2 deployment

For MetaMask or another injected browser wallet, the local staged review helper prepares the selected configuration against two public RPC sources:

```sh
node contracts/scripts/ens-wallet.mjs \
  --config contracts/deployments/ens-two-demo-operators-config-2026-11-07.json \
  --out "$HOME/.local/share/derpc/ens-open-registration-2026-11-07"
```

Open its printed `http://127.0.0.1:8792` URL in the browser with your wallet. Connect each transaction's stated sender on Ethereum mainnet: deployment/parent administration uses its authorized wallet, while registration always uses the operator. Review names, roles and calldata before approving each transaction. These calls transfer zero ETH but consume **real mainnet ETH for gas**. Use **Refresh** to check receipts and prepare the next stage; nothing signs automatically. The two demos share a team owner/operator address, so this specific bootstrap uses the same wallet for both roles. Payments and staking remain disabled.

The helper writes each complete plan, evolving `resume-config.json`, ordered `receipts.json` and a durable `session.json` journal to the chosen directory before opening the wallet. Keep that directory and reuse it when restarting. Unknown results stay locked: recover the transaction hash from wallet history and enter it on the page. Only a wallet's explicit rejection clears a request automatically. Do not delete the journal or start a second evidence directory to bypass a pending request. After an abnormal process exit, inspect the PID in `wallet.lock`; remove that lock only once the original process has stopped. Never remove `session.json` to recover a lock.

After all stages are mined, **Verify deployment** checks the full deployment through both RPC sources, including at least twelve confirmations, exact requests, canonical blocks, runtime and permissions. Only then does it write `deployment-manifest.json`, `deployment-crosscheck.json` and `ens-directory.json`. The last file supplies `VITE_ENS_DIRECTORY` or the GitHub `DERPC_ENS_DIRECTORY` variable; it contains no signing key. Refresh or restart invalidates cached completion and active exported files until verification succeeds again, retaining the previous evidence in `previous-verification.json`. A receipt-checked deployment is still administrative evidence: the final browser must prove discovery after finality through a separately operated gateway before the registered demos can be described as usable.

The server listens only on loopback and checks Host, Origin, a session token and bounded JSON requests. It never receives private keys or signatures and has no transaction submission RPC. Wallet administrative traffic is outside Anon-RPC. The existing CLI commands below remain available for manual review and verification.

The checked-in [preflight observation](deployments/ens-preflight-mainnet.json) records mainnet block 26355465, the existing `derpc.eth` owner and resolver, and an empty subregistry pointer. A [second RPC observation](deployments/ens-preflight-mainnet-second-source.json) agrees on the parent state and upstream runtime hashes. Neither sent a transaction. Refresh those administrative RPC observations before preparing transactions:

```sh
node contracts/scripts/ens-preflight.mjs /tmp/derpc-ens-preflight.json
```

Copy [ens-config.example.json](deployments/ens-config.example.json) or [ens-config-plural.example.json](deployments/ens-config-plural.example.json) to a working configuration. Their null fields are intentional: supply the curator and EOA deployer's public addresses, and 1–3 operators' real public addresses, dedicated resolver cold owners, endpoint hot keys, identity signers, payees, public onion endpoints, capability declarations and fixed Unix-second expiries within 30 days. The curator must control `derpc.eth`'s subregistry permission. Never put a personal-mode hostname or secret in this file.

Several team-run proxies can share one operator entry and its plural endpoint record; remove the second example operator when preparing that configuration. Each node must have its own stable endpoint ID and match the shared name and signer. This is one operator with redundant nodes, not independent operators. Keep its gateway ownership declarations, distinct endpoint-update hot key and free-only plural mode. The full milestone still requires independent operators.

```sh
node contracts/scripts/ens-plan.mjs /tmp/derpc-ens-config.json /tmp/derpc-ens-plan-1.json
```

The plan contains only unsigned wallet requests for the next independent stage. Review the complete requests and role table, submit from the stated wallets, wait for successful receipts, then save `plan.resumeConfig` as the next working configuration and rerun the planner with a new plan filename. Preserve every plan and its transaction hashes. The stages are:

1. Deploy one UserRegistry and a separate PermissionedResolver for each operator through the ENSv2 factory.
2. Deploy the non-upgradeable open registrar. This stage fixes the deployer's creation nonce and registrar address; use its saved `resumeConfig` thereafter.
3. Grant only the planned roles, set the canonical parent, attach the subregistry and grant each hot key access to its selected endpoint record. The existing parent resolver is preserved.
4. Each operator signs its own registration with the fixed lease, zero token-owner roles and dedicated resolver.

The curator receives parent-setting and registration/renewal administration on the subregistry. The registrar receives operational registration/renewal authority. Neither receives unregister, transfer or upgrade authority through this plan. Each resolver's cold owner administers text records; its hot key can change only the chosen `derpc.endpoint` or `derpc.endpoints` key. Existing conflicting contracts, parent pointers or role grants cause refusal, not implicit replacement.

### Join from an operator wallet

After the initial namespace deployment, a new operator uses [ens-join.mjs](scripts/ens-join.mjs) rather than extending the owner's bootstrap roster. Supply its verified public deployment manifest and one public operator entry (or the website's downloaded `operatorConfig` fragment):

```sh
node contracts/scripts/ens-join.mjs \
  --deployment /path/to/deployment-manifest.json \
  --operator /path/to/operator-entry.json \
  --out "$HOME/.local/share/derpc/my-operator-registration"
```

The helper prints a loopback wallet-review URL, normally `http://127.0.0.1:8793`. The operator connects their own wallet. It prepares three stages: deploy a dedicated ENS resolver with the public records, authorize the separate endpoint hot key, then register the name. **All three senders are the operator; no parent-owner transaction or service approval is involved.** The operator must also be the resolver cold owner for this flow. One singular endpoint or a bounded plural list is accepted; payment records are disabled. The helper does not generate keys, request private keys or sign automatically.

Review and retain the evidence directory as described above. Both administrative sources must agree before each request. The helper checks the attached subregistry, exact registrar runtime, immutable curator/registry, ENS factory implementations, scoped permissions, available label, blocked address/name, lease and list capacity. It does not require other members to appear in the new operator's configuration. A full list can reuse a delisted or expired slot without overwriting an active lease. The three exact operator-signed receipts must pass twelve-confirmation verification; an altered sender, calldata, pin, source, review block or journal causes refusal. A previously submitted request is never silently resubmitted.

Choose a fixed expiry and keep the same inputs across restarts. A new `--deployment-id` deliberately selects a different resolver address; it is not a way to bypass an unresolved transaction. Enrollment evidence still does not prove onion reachability, reciprocal service identity, independent ownership or honest responses. The browser's finalized, proven discovery and normal verification remain required before using the new operator.

Older curator-only plans are historical. Do not combine them with this registrar's changed source or runtime hash; prepare fresh plans and use a separate owner-setup evidence directory if no old transaction was submitted. If an old request is pending, reconcile it before proceeding.

### Endpoint records

A plural operator supplies a raw `endpoints` array in its configuration, omitting both `endpoint` and `beacon` entirely:

```json
{
  "endpoints": [
    { "id": "east", "url": "https://east.example/rpc", "beaconUrl": "https://east.example/beacon" },
    { "id": "west", "url": "https://west.example/rpc", "beaconUrl": "https://west.example/beacon" }
  ]
}
```

The shared provider serializer produces the canonical `derpc.endpoints` value `{"version":1,"endpoints":[...]}`. It permits 1–8 entries and at most 4096 UTF-8 bytes. IDs contain 1–31 lowercase letters, digits or internal hyphens; IDs and canonical RPC URLs must be unique. URLs must use HTTPS or a valid v3 onion host, without credentials, query strings or fragments. When `caps.beacon` is true every node needs `beaconUrl`. Plural operators cannot include payment configuration or nonempty payment records. Their standalone `derpc.endpoint` and `derpc.beacon` records are cleared; legacy operators keep those records and clear `derpc.endpoints`.

Set each wrapper's `DERPC_ENDPOINT_ID` to its entry's exact `id` and use the [wrapper setup/self-test](../wrapper/README.md#several-endpoints-under-one-operator). Discovery checks that `endpointId` in the reciprocal identity document. Setup proposes one entry; merge it into the complete reviewed operator list. The deployment planner validates records and on-chain roles, but does not establish wrapper reachability or independent ownership.

Changing an existing resolver between legacy and plural modes produces a separate `migrate-endpoint-permissions-and-records` stage signed by its cold owner. Its single atomic resolver multicall revokes the obsolete key's scoped role, clears that record, updates or clears the standalone beacon record, publishes the selected record and grants only its scoped role. Review the whole request: **the plural hot key controls every RPC and beacon URL in the entire list**, whereas the legacy hot key controls only one RPC URL. A JSON key cannot grant per-node authority. The planner never silently retains both permissions or substitutes a different resolver. Preserve all original and migration plans and receipts when building the updated manifest.

For a legacy paid operator, add `payment: { "priceWei": "INTEGER", "deploymentFile": "path/to/verified-payment-manifest.json" }` to its configuration. The payment manifest must come from the receipt-verification command below on a supported public testnet. The example payment-settings file cannot substitute for that evidence. The registrar remains the explicitly pinned discovery index; the planner does not replace the parent's resolver or write a `derpc.operators` record there.

Fill [ens-receipts.example.json](deployments/ens-receipts.example.json) with each saved plan path and one mined transaction hash per planned transaction, in order. Then produce the final deployment manifest:

```sh
node contracts/scripts/ens-verify.mjs /tmp/derpc-ens-config.json \
  /tmp/derpc-ens-receipts.json /tmp/derpc-ens-manifest.json
```

All three ENS commands accept an optional RPC URL as the final argument, or `ENS_RPC_URL`; otherwise they use the configured public endpoint. They never sign or send. Verification checks matching successful canonical receipts with at least 12 confirmations, source/compiler identity, current code, exact state and roles, plus every configured hot key's role-event history across all dedicated resolvers. It reconstructs each saved stage against its canonical review block, requires receipts after that review, and checks that mode changes used the reviewed atomic migration. The manifest preserves factory `initialRecords` separately from current `records`; editing the old manifest's records cannot replace migration evidence. It rechecks historical hashes and the final observation after its reads. This is administrative RPC evidence. Client-side discovery still needs the manifest's registrar pin and the appropriate proof mode; a deployment manifest alone does not authenticate a browser lookup.

The [local fork report](deployments/ens-fork-evidence.json) records the real mainnet contract-code test of the unmodified planner/verifier pipeline, endpoint-only grants, disallowed transfer/record changes, renewal/delisting and expiry. Its transactions and confirmations occurred on a local fork. The reproduction procedure is in `contracts/test/ens-fork.test.mjs`; no public deployment follows from that report.

The registrar's rules were tightened after a review on November 6: curator-only renewal of lapsed leases, removal that names the operator, reinstatement, slot reuse and the hyphen rule. The [fork run with that source](deployments/ens-registrar-rules-fork-evidence-2026-11-06.json) passed all five fork tests against the real ENS bytecode, including giving an expired label to a new owner. The older fork reports linked in this section were recorded with the earlier registrar source.

The [deployment-to-discovery report](deployments/ens-fork-discovery-evidence.json) connects that planner to the real provider: membership/payees, nine-record resolver batches, tampered proofs, identity mismatch and renewal/removal/expiry. Anvil could not supply a mined fork root, so the test materialized the exact traced prestate and injected a common local proof root. It proved ten accounts and 56 slots per refresh and compared 85 direct reference results. This is local integration evidence; consensus and transport anonymity are tested separately. The initial two-operator scan required 87 proof and 20 code requests, so public-network discovery latency still needs measurement.

### ENS operator lifecycle

`ens-lifecycle.mjs` prepares one unsigned operation against a receipt-checked ENS deployment manifest. It never signs, sends, grants permissions, changes a resolver or enables payments. It accepts free operators using either endpoint mode. After migration, use the updated manifest produced from the original deployment and migration receipts. Independent operators' public configuration and wallet signatures remain deferred inputs; the examples below do not enroll substitute operators.

| Action JSON `type` | Required fields besides the existing operator `label` | Authorized sender and effect |
| --- | --- | --- |
| `rotate-endpoint` | `expectedEndpoint`, `newEndpoint` | That resolver's endpoint hot key sets only `derpc.endpoint`; ownership, signer, payee and other records stay fixed. |
| `rotate-endpoints` | `expectedEndpoints`, `newEndpoints` (complete entry arrays) | That resolver's plural hot key replaces only `derpc.endpoints`, including any beacon URLs within it. The entire canonical prior list must match. |
| `delist` | None | The curator calls `OperatorRegistrar.remove(index, operator)`, clearing active admission while preserving the ENS token and its lease. The tool does not prepare `reinstate`. |
| `renew` | `expectedExpiry`, `expiry`, optional `authority` (`operator` by default, or `curator`) | The recorded operator or curator extends the lease to a fixed future Unix-second expiry, within 30 days and the parent lease. A lapsed lease that is still active recovers only with `authority: "curator"`; removed entries cannot renew. |

Start from [ens-lifecycle-action.example.json](deployments/ens-lifecycle-action.example.json) or [ens-lifecycle-endpoints-action.example.json](deployments/ens-lifecycle-endpoints-action.example.json), fill its null fields from the intended operator's public configuration, and keep the receipt-checked deployment manifest unchanged:

```sh
node contracts/scripts/ens-lifecycle.mjs prepare /tmp/derpc-ens-manifest.json \
  /tmp/derpc-ens-action.json /tmp/derpc-ens-lifecycle-plan.json
node contracts/scripts/ens-lifecycle.mjs check /tmp/derpc-ens-manifest.json \
  /tmp/derpc-ens-lifecycle-plan.json /tmp/derpc-ens-lifecycle-check.json
```

Review the exact sender, destination, calldata, zero value, gas estimate and before-state. Run `check` immediately before the authorized wallet submits the plan's `walletRequest`. The review window is 15 minutes. These existing contracts have no compare-and-swap or transaction-deadline parameter: a raced or late transaction can still execute on-chain. A fresh check reduces that risk; receipt verification refuses changed preconditions or a transaction mined after the review deadline. Check wallet history before retrying a pending or uncertain submission. Already-applied rotations or delistings are refused rather than automatically submitted again.

For plural rotation, include all existing nodes in both arrays even when changing only one URL. A concurrent edit to another node invalidates the reviewed prior list. Preserve stable IDs when moving a node; removing an entry is an explicit whole-list edit. Every new beacon URL is under the same hot-key authority as the RPC URLs. Delisting and expiry apply to the operator and therefore all its nodes.

After the wallet supplies a successful transaction hash, verify it with at least 12 confirmations:

```sh
node contracts/scripts/ens-lifecycle.mjs verify /tmp/derpc-ens-manifest.json \
  /tmp/derpc-ens-lifecycle-plan.json 0xACTUAL_TRANSACTION_HASH \
  /tmp/derpc-ens-lifecycle-evidence.json
```

Each command accepts an optional administrative RPC URL last, or `ENS_RPC_URL`. These reads and the wallet's update transaction are outside Anon-RPC. Verification reconstructs the allowed calldata, binds the original manifest/source/runtime and exact signer, and checks canonical review, receipt-parent, receipt and current blocks. It checks parent ownership/pointers, original token identity, dedicated resolver implementations, zero name roles, exact root permissions and every configured hot key's role history across the managed resolvers. Unknown scoped grants and protected-record changes cause refusal.

The same-block race check conservatively rejects any other transaction emitting an event from the managed registrar, registries, resolvers or ENS factory in the receipt block. This includes unrelated activity in the shared ETHRegistry or factory, so a legitimate public transaction can fail this verification gate. That does not undo the mined transaction or justify resubmitting it; inspect the receipt and obtain a separate transaction-level review. The check relies on the pinned ENS implementations emitting events for managed state changes.

Evidence reports `pending-finality`, `finalized` or unavailable finality separately from confirmation count. It always leaves `clientRefreshVerified: false`. An on-chain change affects the demonstrated directory only after a separate successful refresh against an authenticated finalized snapshot. No immediate global revocation or verified browser refresh follows from an administrative receipt check.

The [local lifecycle report](deployments/ens-lifecycle-fork-evidence.json) records actual ENS bytecode tests for restricted rotation, unrelated-record/cross-operator denial, stale/tampered/same-block plans, renewal after expiry, curator renewal and token-preserving delisting. The [concrete local plan example](deployments/ens-lifecycle-fork-example.json) contains executable-shaped calldata from that disposable fork; it is **not a public deployment or a request to submit it**. Its `.example` endpoints and development-wallet addresses are fixtures. Reproduce with a recent mainnet fork, or an archive-capable upstream for a pinned historical block:

```sh
anvil --fork-url "$ENS_FORK_UPSTREAM_RPC" --chain-id 31337 --port 8855 --silent
DERPC_ENS_FORK_RPC=http://127.0.0.1:8855 \
DERPC_ENS_LIFECYCLE_REPORT=/tmp/derpc-ens-lifecycle-report.json \
  pnpm --filter @derpc/contracts exec vitest run test/ens-lifecycle.test.mjs test/ens-fork.test.mjs
```

The test refuses non-loopback endpoints and non-Anvil/non-fork nodes, begins on chain 31337, temporarily uses chain 1 only inside its local snapshot, and restores that state afterward. Its finality-tag fixture tests labeling; it does not establish mainnet consensus finality, anonymous discovery or independent operator enrollment.

The [plural endpoint fork report](deployments/ens-endpoints-fork-evidence.json) extends that actual-code run with fresh plural deployment, atomic migrations in both directions, rollback after a late failed inner call, exact selected-key permissions, complete-list rotation, operator-wide delisting and rejection of forged migration/provenance or reorg evidence. The [concrete plural plans](deployments/ens-endpoints-fork-example.json) contain local fixture calldata for migration and rotation, explicitly unsuitable for public submission. Reproduce the focused unit and fork checks with:

```sh
DERPC_ENS_FORK_RPC=http://127.0.0.1:8855 \
DERPC_ENS_ENDPOINTS_REPORT=/tmp/derpc-ens-endpoints-report.json \
  pnpm --filter @derpc/contracts exec vitest run test/ens-endpoints.test.mjs \
  test/ens-plan.test.mjs test/ens-lifecycle.test.mjs test/ens-fork.test.mjs
```

### Test-payment deployment

Hoodi (chain 560048) hosts the current test escrow; Sepolia (11155111) is also accepted. This is independent of mainnet ENS and mainnet read verification. The pinned read light client's Sepolia incompatibility does not prevent a Sepolia escrow deployment: payment transactions and session checks use the wallet/operator's separate payment-chain clients. Neither choice approves a production payment chain. For a fresh deployment, the preparation command emits an unsigned wallet request and never takes a private key or submits a transaction:

```sh
node contracts/scripts/payment-deploy.mjs prepare \
  --chain-id 560048 --from 0xDEPLOYING_WALLET \
  --out /tmp/derpc-payment-plan.json \
  --rpc https://YOUR_HOODI_RPC
```

Replace placeholders with the wallet's public address and its testnet RPC. `--rpc` is optional for offline preparation; supplying it checks the chain and records a deployment gas/balance sample. That observation is explicitly labelled an administrative RPC result, not a light-client proof.

The user deployed the reviewed escrow at **`0x9053513aCA73bAc0aF6a9942fd93832fd313B0bb`** on Hoodi in [transaction `0xb8b53e…7955`](https://hoodi.etherscan.io/tx/0xb8b53eaebe08d00d8d9e976a6897be5f8e5b145fd59052ac6be7ed11b36a7955), block 3962188. Use the [verified deployment manifest](deployments/payment-hoodi-deployment-2026-11-06.json) for the payment UI and operator configuration. The [independent RPC check](deployments/payment-hoodi-crosscheck-2026-11-06.json) agrees on the creator, canonical receipt and exact compiled creation/runtime code. Both checks observed 12 confirmations; the block was not yet finalized. The receipt records 892,743 gas and a fee of 0.000897098867181885 test ETH. These are administrative RPC observations, not light-client verification or evidence of a paid read/settlement cycle.

The [original unsigned Hoodi plan](deployments/payment-hoodi-plan-2026-11-06.json) remains unchanged as the reviewed input; its preparation status and gas sample describe the time before signing. Use the deployment manifest above for the deployed contract. For a fresh deployment, refresh the preflight and regenerate the plan if the deployer changes.

For a browser extension wallet, open the local review helper:

```sh
node contracts/scripts/payment-wallet.mjs \
  --plan contracts/deployments/payment-hoodi-plan-2026-11-06.json \
  --port 8791
```

Open the printed loopback URL in the browser containing your wallet. The helper recompiles and checks the exact escrow creation code, source/runtime hashes, test chain, sender and zero transferred value before serving the page. Connect the matching account, review the plan, and approve in the wallet. It never receives private keys or sends a transaction automatically. Wallet RPC goes outside Anon-RPC. A pending or uncertain submission is saved in that tab before the wallet call and blocks a retry after reload; check wallet history if no hash returns. A returned hash remains **unverified** until the receipt-verification command below succeeds. The helper does not deploy ENS or accept arbitrary transaction plans.

The wallet selector discovers extensions through [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963), with a legacy injected-provider fallback, following [MetaMask's provider guidance](https://docs.metamask.io/metamask-connect/evm/reference/provider-api/). Discovery does not request accounts or sign anything. Select MetaMask explicitly if several wallets are installed. If none is detected, open the URL in the normal browser profile where the extension is enabled, allow its access to this site, and click **Detect wallets**. Embedded previews may not expose extensions. Connection errors appear beside the review checkbox as well as at the top; if MetaMask reports an already pending request, open the extension and finish or cancel it before reconnecting. A wallet selection change invalidates the previous review, and repeated wallet announcements never replace a provider during an active request.

The checkbox stays disabled if the sender or network differs from the plan. For the prepared Hoodi plan, connect the matching account and click **Switch to Hoodi** if the wallet shows another chain. This explicitly requests [`wallet_switchEthereumChain`](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/wallet_switchEthereumChain/); only an unknown-chain error triggers an add-network request with fixed testnet metadata shown on the page. Hoodi uses `https://rpc.hoodi.ethpandaops.io`, chain 560048, and test ETH. The alternative Sepolia plan uses `https://ethereum-sepolia-rpc.publicnode.com`, chain 11155111, and test ETH. After wallet approval, the helper rereads the active chain and account, then enables review if both match. Switching never submits a transaction or checks the review box automatically. These network requests go through the wallet, outside Anon-RPC.

The wallet owner reviews `walletRequest` and sends it on the stated network. After it is mined, verify the actual receipt and runtime:

```sh
node contracts/scripts/payment-deploy.mjs verify \
  --plan /tmp/derpc-payment-plan.json --tx 0xACTUAL_DEPLOYMENT_HASH \
  --rpc https://YOUR_HOODI_RPC --confirmations 12 \
  --out /tmp/derpc-payment-deployment.json
```

Verification refuses a changed source/build, wrong sender or chain, wrong creation transaction, failed receipt or mismatched runtime. `contracts/deployments/payment-settings.example.json` is marked `not-deployed`: it is not a verified manifest and must not enable payment UI. `--local` is reserved for loopback chains 1337/31337 and cannot turn local evidence into a public-testnet deployment.

A deployment receipt is only the first payment gate. Record a public test-funded open → verified reads → final voucher → close cycle, plus a timeout-refund cycle. Do not interpret an unsigned plan, local mock registry, address prediction or temporary test trace as a completed public deployment. The [operations checklist](../specs/OPERATIONS.md) records the remaining gates.

### Local gas measurement

```sh
node contracts/scripts/payment-deploy-measure.mjs --out /tmp/derpc-payment-gas.json
```

This runs an ephemeral Ganache chain and records actual local receipts, source/runtime hashes, compiler settings, gas used and per-receipt gas prices. The [saved November 6 measurement](deployments/payment-local-gas-2026-11-06.json) used Solidity 0.8.30, Shanghai, optimizer 200, EOA recipients, a `10^15` wei deposit and a 12,345 wei cumulative claim:

| Operation | Gas used | Fee in local test wei |
| --- | ---: | ---: |
| Deploy | 892,743 | 1,673,893,125,000,000 |
| Open | 144,501 | 256,075,219,667,085 |
| Top up | 44,166 | 74,046,399,004,968 |
| Close | 66,023 | 105,123,676,374,484 |
| Refund | 49,917 | 69,761,123,132,211 |

The open/close path used **210,524 gas**; the open/timeout-refund path used **194,418 gas**. Measured source hash: `0x59cdd63dcbc242cb72fb438ce531c63a170178d264678d87fbf22fde7eeec643`; runtime hash: `0xfd80231e110458a6dd83da9dfeffa6650e50fb8c8371fe58c49c8cfb6a81ac24`. Rerun after any source, compiler, recipient or calldata change. These local fee values are not live network quotes and exclude rollup data fees. They do not select a production chain or establish operator income.

The [November 7 measurement](deployments/payment-cost-measurement-2026-11-07.json) adds deterministic disposable accounts/time, mined failed close/refund attempts, rejecting recipient fixtures, deferred withdrawals and exact accounting checks. All 16 receipts reproduced across two runs. Its close uses 66,039 gas under different calldata; deferred close uses 114,697 and each successful withdrawal 50,332, including fixture forwarding overhead. The minimal fixtures are not representative production smart wallets.

Append `--sample-fees` to collect read-only Hoodi and two-source mainnet gas-price observations after the local chain stops. The report multiplies each local gas count by the observed quote and shows assumed read-volume sensitivity. Those projections are not public lifecycle receipts, atomic block/price observations, actual demand or a minimum deposit/reserve recommendation. Public fee sampling loads no signer and submits no transaction.

Before real funds, obtain an independent contract review and the legal review described in that checklist. Neither this README nor an automated review establishes those outcomes.
