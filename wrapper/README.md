# Operator wrapper

The wrapper puts a Tor v3 onion service in front of a filtering proxy. It does not verify responses: DeRPC's host still checks consensus, account, code and storage proofs. No Tor gateway is included.

Source-based setup requires Linux, Docker Compose, Node 24 (for the setup command), and synchronized mainnet execution and consensus nodes. Keep their APIs bound to `127.0.0.1`; this compose stack uses host networking so it can reach them without publishing the node APIs. A light client is not an operator node. The downloadable Docker package described below does not require Node on the operator host.

```sh
export DERPC_ENS_NAME=alice.derpc.eth
export DERPC_SIGNER=0x0000000000000000000000000000000000000001
export DERPC_EXECUTION_URL=http://127.0.0.1:8545
export DERPC_BEACON_URL=http://127.0.0.1:5052
pnpm --filter @derpc/wrapper run setup
```

Use your own signer address and an operator label of 1–31 lowercase letters, digits or hyphens, starting and ending with a letter or digit. Setup starts the stack, checks the canonical tor-js specifier's slot-1 proof at the node's finalized block and a beacon finality update through the local wrapper, then prints records to publish. It never publishes ENS records or sends a transaction. A successful local self-test is not an onion reachability test; check that separately through the browser's pinned Anon-RPC worker. Use `run setup`: `pnpm setup` names pnpm's own built-in command.

For a demonstration proxy, configure public upstreams and set `DERPC_DEMO_PROXY=true`. The identity document labels it `demo-proxy`: forwarding somebody else's node does not add an independent operator.

## Downloadable Docker releases

The release workflow builds separate **Linux x64 and ARM64** archives containing
the wrapper and Tor images, Compose configuration, an environment example and the
`derpc-wrapper` launcher. Operators need Docker Engine with Compose v2, Bash and
coreutils; no source checkout, build tools, Node, pnpm or registry login is needed.
This package starts the free pool service only. The source-based personal/payment
configurations remain separate.

Download the matching archive and `.sha256` file from [GitHub Releases](https://github.com/r0bops/DeRPC/releases),
verify it with `sha256sum --check <archive-name>.sha256`, and extract it. Inside:

```sh
./derpc-wrapper install
# Edit .env with your node URLs, ENS name, public signer and stable node ID.
./derpc-wrapper up
./derpc-wrapper check
```

The check command runs inside the image, checks finalized proof availability and
beacon finality, and prints an unsigned ENS record proposal. It does not publish
records or prove public onion reachability. Test that separately through Anon-RPC.
`down` preserves the key volume; upgrades keep the same explicit Compose project.
The archive's [operator instructions](release/README.md) explain configuration,
backup, upgrades and the migration boundary for existing source-based deployments.

Maintainers build a native package with:

```sh
node wrapper/scripts/package-release.mjs --version 0.1.0 --arch x64
# On a native ARM64 Linux host, use --arch arm64.
```

Outputs are under `wrapper/out/releases/`. The builder tests the actual images
with networking disabled, checks Tor's pool-only configuration, and installs and
reinstalls the extracted archive with a PATH that contains no Node command.
It records image IDs, the source commit, architecture, runtime checks and whether
the local source had uncommitted changes. CI requires the exact clean commit.
These checks do not establish public Tor availability or operator enrollment.

The `release-wrapper.yml` workflow can be run manually to build artifacts without
creating a release. A pushed `wrapper-vX.Y.Z` tag builds both architectures on
native runners and creates a draft only after both pass. Manual draft creation
requires `main` and an existing matching tag at the tested commit. Review and
publish the draft to make downloads public; existing releases are never replaced.

## Several endpoints under one operator

Run a separate wrapper/onion stack on each node host. Use the same `DERPC_ENS_NAME` and public `DERPC_SIGNER`, and give each node a stable, unique ID:

```sh
export DERPC_ENDPOINT_ID=node-1
pnpm --filter @derpc/wrapper run setup
```

The ID contains 1–31 lowercase letters, digits or hyphens and starts and ends with a letter or digit. It must match that node's `id` in the operator's `derpc.endpoints` record. Each wrapper publishes `endpointId` in its reciprocal identity document; discovery checks that exact value along with the ENS name, signer and chain. The declaration does not prove ownership of the upstream node or independence from sibling endpoints. Preserve the ID when rotating its onion URL, and back up each node's configuration and onion keys separately. The supplied Compose stack uses fixed host ports, so starting two stacks on one host requires a separate, deliberately reviewed port/Tor configuration.

With `DERPC_ENDPOINT_ID`, setup prints `kind: "derpc-endpoint-record-proposal"` and `status: "merge-required-not-published"`. Its `endpoint` field is one `{ id, url, beaconUrl }` entry; `singleEndpointRecord` shows its version-1 `derpc.endpoints` JSON, and `commonRecords` contains the signer and capabilities. **Merge the entry into the complete reviewed operator list before publishing.** Setup does not read existing ENS records, so its one-node example cannot preserve other nodes by itself. The full list allows 1–8 entries and at most 4 KiB of UTF-8 JSON. IDs and canonical RPC URLs must be unique; URLs cannot contain credentials, query strings or fragments. Use the [ENS deployment tooling](../contracts/README.md) to validate the full configuration, clear legacy singular records and scope the hot key to the complete plural record. That hot key can replace the entire list; it is not restricted to one node within it.

Multi-endpoint wrappers are free-only. Startup and setup refuse `DERPC_ENDPOINT_ID` together with `DERPC_PAYMENT_ESCROW`; separate wrappers must not share a funded session or its journal. Personal mode remains a separate authenticated, unpublished listener. Omit `DERPC_ENDPOINT_ID` for an existing legacy singular endpoint; its identity and setup record format remain unchanged.

## Node configuration

The wrapper needs two things from the node behind it:

- **Execution client:** `eth_getProof` and `eth_getCode` at the node's own finalized block, plus `eth_getBlockByNumber("finalized")`. The finalized block is normally about 65–95 blocks behind the head, and further behind when finality is delayed, so the node has to keep enough recent state to build proofs that far back.
- **Consensus client:** the four light-client routes listed under [Exposed routes and limits](#exposed-routes-and-limits).

The settings below were read from each client's own documentation on Nov 6, 2026. None of them was confirmed by running that client here. The self-test remains the acceptance check for a particular node and version: it requests a proof at the finalized block and a finality update through the wrapper, and stops if either fails.

### Execution clients

Keep the HTTP API on `127.0.0.1`. The wrapper reads `DERPC_EXECUTION_URL`, by default `http://127.0.0.1:8545`.

| Client | Configuration |
| --- | --- |
| Reth | Enable `--http --http.addr 127.0.0.1 --http.api eth`. Set `--rpc.eth-proof-window 256` initially, and increase if the finalized block falls outside that window. Its default is zero. [Reth node CLI](https://reth.rs/cli/reth/node/) |
| Geth | Enable `--http --http.addr 127.0.0.1 --http.api eth` (port 8545 by default). A full node keeps only the most recent 128 block states, which normally includes the finalized block but leaves little room when finality is late. For proofs at older blocks, the archive-mode page describes `--history.trienode=N` with the path-based state scheme, from v1.17; `--history.state` alone keeps state but not the trie nodes a proof needs. [Command-line options](https://geth.ethereum.org/docs/fundamentals/command-line-options), [sync modes](https://geth.ethereum.org/docs/fundamentals/sync-modes), [archive mode](https://geth.ethereum.org/docs/fundamentals/archive) |
| Nethermind | Enable `--JsonRpc.Enabled true`. It listens on `127.0.0.1:8545` by default, and `eth` is among the default `JsonRpc.EnabledModules`. `Pruning.PruningBoundary`, the number of past states kept before pruning, defaults to 64, which can be less than the distance to the finalized block; raise it (for example `--Pruning.PruningBoundary 256`) and confirm with the self-test. [Configuration](https://docs.nethermind.io/fundamentals/configuration), [JSON-RPC server](https://docs.nethermind.io/interacting/json-rpc-server) |
| Besu | Enable `--rpc-http-enabled`. The host defaults to `127.0.0.1`, and the default `--rpc-http-api` list includes `ETH`. With Bonsai, the default storage format, `--bonsai-historical-block-limit` sets how many previous blocks' state Besu can reconstruct; the default is 512. The documentation doesn't say separately how far back proofs are served, so rely on the self-test. [Options](https://docs.besu-eth.org/public-networks/reference/options), [data storage formats](https://docs.besu-eth.org/public-networks/concepts/data-storage-formats) |
| Erigon | The HTTP server is on by default at `localhost:8545`, and `eth` is in the default `--http.api`. Proofs at past blocks need `--prune.include-commitment-history=true`, described as stable from v3.4 and as needing at least 32 GB more RAM. `--prune.commitment-history.distance N` limits how many blocks of that history are kept. [eth API notes](https://docs.erigon.tech/interacting-with-erigon/eth), [CLI reference](https://docs.erigon.tech/fundamentals/configuring-erigon) |

### Consensus clients

Keep the REST API on `127.0.0.1` and set `DERPC_BEACON_URL` to it. The wrapper's default is `http://127.0.0.1:5052`; several clients use another port.

| Client | Configuration |
| --- | --- |
| Lighthouse | Enable `--http --http-address 127.0.0.1 --http-port 5052`. Do not disable light-client serving. Current releases describe `--disable-light-client-server`; check your installed version's help. [Beacon node CLI](https://lighthouse-book.sigmaprime.io/help_bn.html) |
| Lodestar | The REST API is on by default at `127.0.0.1:9596`, and `lightclient` is in the default `--rest.namespace` list. Do not pass `--disableLightClientServer`, and keep `lightclient` if you set the namespaces yourself. Use `DERPC_BEACON_URL=http://127.0.0.1:9596`. [Beacon CLI reference](https://chainsafe.github.io/lodestar/run/beacon-management/beacon-cli/) |
| Nimbus | Enable `--rest` (off by default; `127.0.0.1:5052`). `--light-client-data-serve` is on by default. `--light-client-data-import-mode` defaults to `only-new`, which imports new data as it arrives; `full` and `on-demand` also import historic data, which the documentation warns is expensive and can cause missed validator duties. [Options](https://nimbus.guide/options.html), [light client data](https://nimbus.guide/light-client-data.html) |
| Prysm | Pass `--enable-light-client`; it is off by default. The HTTP API listens on `127.0.0.1:3500` by default (`--http-host`, `--http-port`). Use `DERPC_BEACON_URL=http://127.0.0.1:3500`. [Parameters](https://prysm.offchainlabs.com/docs/configure-prysm/parameters/) |
| Teku | Not usable as documented. Teku's CLI reference and its published REST API list no light-client routes. [CLI reference](https://docs.teku.consensys.com/reference/cli), [REST API](https://consensys-incorporated.github.io/teku/) |
| Grandine | Not usable. Its documentation states that the light-client endpoints are not served. [Beacon Node API](https://docs.grandine.io/beacon_node_api.html) |

Erigon's built-in consensus client (Caplin) was not checked: its Beacon API page doesn't mention the light-client routes. No archive-node claim is made for any client: what matters is retaining enough state to prove the finalized block.

## Exposed routes and limits

- `POST /rpc`: `eth_getProof`, `eth_getCode`, `eth_chainId`. Every batch member is validated before forwarding. No notifications, writes, arbitrary calls, or `latest` reads.
- `GET /eth/v1/beacon/light_client/{bootstrap/<root>,updates,finality_update,optimistic_update}`: unpaid, separate concurrency and response limits. Updates require `start_period` and `count` (1–4).
- `GET /.well-known/derpc.json`: ENS name, signer, chain IDs, protocol version, node/demo-proxy declaration, and `endpointId` when configured. The client compares this with ENS. No extra signature is needed for onion possession; it is not third-party evidence or proof of the ENS lookup.

Defaults: 64 KiB input, 8 requests/batch, 32 storage slots/proof, 15 s deadline, 8 execution requests and 4 beacon requests concurrently, 4 MiB execution output and 2 MiB beacon output. Proof/code cache: 128 entries and 16 MiB, numbered finalized blocks only. The wrapper asks its own node for finality; clients independently authenticate the state root. Credentials and caller headers are not forwarded upstream. Redirects are refused.

## Personal mode

Create a secret outside the repository with `umask 077; openssl rand -hex 32 > /absolute/path/personal-token`, set `DERPC_PERSONAL_TOKEN_FILE` to its absolute path, then rerun setup. The personal compose override mounts the token as a secret. The wrapper runs as container UID 1000, so the owner-only file must be readable by that UID; on a host with another user ID, arrange private ownership/access deliberately. Do not make the token world-readable. The separate unpublished onion forwards to port 8788, authenticates every request and has an independent cache and concurrency limit. There are no payment or registry requirements. Never publish the personal hostname or token in ENS. Read the hostname locally with:

```sh
cd wrapper
docker compose -f compose.yaml -f compose.personal.yaml exec -T tor cat /var/lib/tor/personal/hostname
```

Add this as a chosen provider operator, held in memory:

```ts
{ id: 'my-node', url: 'http://<private-v3-address>.onion/rpc', priority: -1,
  operator: 'My own node', personalToken: token }
```

Select other operators as fallbacks. Proof verification applies to personal mode too. The gateway still sees the user's IP; other chosen operators see query content when a read fails over. Do not persist the token in application logs or local storage.

## Test payments

First deploy and verify a test escrow using [the contract guide](../contracts/README.md#test-payment-deployment). Configure these values in the shell before rerunning setup:

```sh
export DERPC_PAYMENT_CHAIN_ID=560048
export DERPC_PAYMENT_RPC_URL=https://YOUR_HOODI_RPC
export DERPC_PAYMENT_ESCROW=0xYOUR_VERIFIED_TEST_ESCROW
export DERPC_PRICE_WEI=YOUR_INTEGER_PRICE_PER_VERIFIED_READ
export DERPC_SETTLEMENT_KEY_FILE=/absolute/path/outside-the-repo/settlement-key
pnpm --filter @derpc/wrapper run setup
```

Use a separate operator settlement key whose public address is the escrow payee, funded with test gas on that chain. The secret file contains one `0x`-prefixed 32-byte key and must remain owner-only while readable by container UID 1000 (the tested configuration uses UID 1000 ownership and mode `0600`). `DERPC_SIGNER` is the public identity/record-management address; it is not a substitute for the settlement key. Setup prints only the derived public payee and payment records.

When `DERPC_PAYMENT_ESCROW` is present, setup includes `compose.payments.yaml`. It mounts the key as a Docker secret and keeps the voucher journal in the `payment-state` named volume. Preserve that volume across restarts and upgrades. The wrapper checks confirmed sessions through `DERPC_PAYMENT_RPC_URL`; `DERPC_PAYMENT_CONFIRMATIONS` defaults to 2. It refuses payment-chain heads older than 180 seconds, persists accepted totals before acknowledging them, and writes signed closing transactions durably before broadcasting. After restart it can rebroadcast the same transaction. Settlement polling runs every 15 seconds with a 600-second safety margin. That administrative connection is outside the browser's anonymous worker. Monitor settlement errors and fund sufficient test gas before a session's refund deadline.

Beacon routes, identity, `eth_chainId` and the exact worker-pin bootstrap proof remain available without payment; ordinary pool reads require the session authorization. Personal mode stays unpaid and uses its separate listener. Payments bind queries to a funded session and its payer even though the operator receives the read through Tor.

## Keys and operational limits

Tor stores the pool and personal onion keys in the `onion-keys` named volume, never in an image. For an encrypted backup, install `age` on the trusted backup host, set `DERPC_BACKUP_RECIPIENT` to the owner's age recipient and `DERPC_BACKUP_PATH` to a new file on the chosen backup device, then run:

```sh
cd wrapper
umask 077
set -o pipefail
: "${DERPC_BACKUP_RECIPIENT:?set the owner age recipient}"
: "${DERPC_BACKUP_PATH:?set a new encrypted backup file path}"
docker compose -f compose.yaml stop tor
if docker compose -f compose.yaml run --rm --no-deps --entrypoint tar tor \
  -C /var/lib/tor -cpf - . | age -r "$DERPC_BACKUP_RECIPIENT" > "$DERPC_BACKUP_PATH"
then
  docker compose -f compose.yaml start tor
else
  docker compose -f compose.yaml start tor
  printf '%s\n' 'Backup failed; do not use the output file.' >&2
  false
fi
```

The plaintext archive travels only through the pipe. Test decryption and restoration into a separate volume on a trusted host before relying on it; stop Tor, preserve ownership and permissions and compare the restored public hostname. Choose a recovery recipient and an off-device destination you control. The [November 6 restore drill](test/backup-restore-evidence-2026-11-06.json) separately encrypted onion state and personal configuration, rejected a wrong recovery key, regenerated both original onion names from restored keys with Tor networking disabled, and checked the restored token and proxy identity. That disposable drill tested recovery, not remote reachability or retention of its temporary archives. Back up settlement secrets and payment state under their own access policy; keep them separate from the onion-key archive and outside the source tree. Never print secret-key files. Losing an onion key changes the address; update the endpoint record and repeat the reciprocal identity check.

To repeat the isolated drill against containers you own (the source Tor container briefly stops for a consistent snapshot):

```sh
DERPC_BACKUP_TOR_CONTAINER=YOUR_TOR_CONTAINER \
DERPC_BACKUP_PROXY_CONTAINER=YOUR_PROXY_CONTAINER \
node wrapper/test/backup-restore.mjs
```

The runner removes its temporary archives and recovery keys after checking them. It excludes funded payment journals and settlement keys; never roll back a funded-session ledger from an old backup.

Tor proof-of-work defenses are off because the pinned tor-js client does not enable its solver. Caps reduce resource use but do not establish general denial-of-service resistance. An endpoint cannot prove that it keeps no logs, owns its upstream node, runs unmodified software, or cannot correlate requests. A gateway and RPC service run by the same party must not be paired: supply declared gateways and known gateway owners to DeRPC. Undisclosed ownership remains unknown. A demo that runs both must disclose that limitation.

Run `pnpm --filter @derpc/wrapper test` and `pnpm --filter @derpc/wrapper typecheck` for the local filtering and HTTP tests.

The [November 6 multi-endpoint packaging check](test/multiendpoint-packaging-evidence-2026-11-06.json) records 58 passing wrapper tests, shared-schema compatibility and a built image exercised with Docker networking disabled. It checked node identity, Compose configuration, and startup refusal for paid plural mode and invalid IDs/names. This packaging check made no Tor, node or ENS requests and did not alter the existing live stack.

## Live browser check

Start the frontend dev server and wrapper first. The runner uses Firefox and the pinned browser worker to verify a real mainnet proof through the onion and compare it with an exit connection. It also checks reciprocal identity rejection and failure after the worker is closed. Optional personal-mode configuration adds an authenticated read, missing-token rejection and fallback to a chosen pool operator.

```sh
DERPC_TEST_GATEWAY='GATEWAY_IP:PORT:CERTHASH' \
DERPC_TEST_ONION_URL='http://YOUR_POOL_ADDRESS.onion/rpc' \
DERPC_ENS_NAME='alice.derpc.eth' \
DERPC_SIGNER='0xYOUR_SIGNER_ADDRESS' \
pnpm --filter @derpc/wrapper test:live
```

Use actual values from setup. `DERPC_DEV_ORIGIN` defaults to `http://localhost:5173`; `DERPC_BROWSER_PATH` defaults to `/usr/bin/firefox`. To include personal mode, set `DERPC_TEST_PERSONAL_URL` and `DERPC_PERSONAL_TOKEN_FILE`. The JSON report defaults to `/tmp/derpc-wrapper-live.json` (`DERPC_TEST_REPORT` overrides it) and omits the personal hostname and token. A locally claimed ENS name is useful to exercise the identity check but is not evidence of registration. The [saved live report](test/live-evidence-2026-11-06.json) and [operations checklist](../specs/OPERATIONS.md#live-onion-observation-november-6) record the team's demo-proxy run and shared-gateway limitation.

Set `DERPC_TEST_ENS_RESOLVER` to an actual ENSv2 resolver to include a verified local `resolve()` call through the onion. The runner defaults to the `url` text record for `derpc.eth`; `DERPC_TEST_ENS_KEYS` supplies a comma-separated list for a resolver multicall. It rejects a trace that forwards `eth_call` upstream. The saved run used `0xF645Ba7C7aE2A6915d0B904F39D4AadD7d899B59` and proved an empty record; it did not deploy or discover the operator subregistry.

For a focused availability check, use the same public endpoint/name/signer/gateway environment variables and run:

```sh
node wrapper/test/onion-availability.mjs
```

This starts a fresh Firefox profile and sends both consensus and execution requests through that onion, with the provider's normal identity, RPC and pool deadlines. It records header/body timings, structured failures, source/dependency hashes, verified balance/storage and shutdown. It does not reset the running wrapper cache or Tor service. `DERPC_TEST_REPORT` selects the output JSON; `DERPC_TEST_WORKER_LOG_LEVEL=debug` adds worker diagnostics. Use public fixtures only and review diagnostic logs before sharing them.

The [November 6 availability evidence](test/onion-availability-evidence-2026-11-06.json) passed on the current provider at mainnet block 26356531: startup 15.836 seconds, worker-pin plus balance 18.636 seconds, and storage 2.387 seconds. No direct execution/beacon RPC was observed and no calls followed shutdown during the observation. An earlier instrumented run showed hidden-service descriptor/circuit failure and rendezvous recovery before HTTP; the historical uninstrumented timeout cannot be assigned the same cause conclusively. No production timeouts were raised. This is functional evidence from a same-party gateway/demo-proxy setup with a mock ENS identity, not sustained uptime, independent ownership or a public-site deployment.

### Multiple endpoints under one operator

The isolated M1-B runner creates two temporary wrappers and public onion services for the mock identity `multi.derpc.eth`. Its keys live in a disposable container tmpfs. It verifies each node sequentially with a public WETH fixture before testing the group, forces an HTTP 503 at the selected RPC ingress, and checks sibling failover and account affinity. Only then does it explicitly add MEV Blocker for the other-operator fallback. Consensus and execution use the browser's anonymous transport; production timeouts and cooldowns are unchanged.

From the repository root, with Docker, Firefox and a running frontend Vite server:

```sh
docker build -t derpc-multiendpoint-tor -f wrapper/Dockerfile.tor wrapper
DERPC_TEST_GATEWAY='GATEWAY_IP:PORT:CERTHASH' \
DERPC_TEST_ENS_CHECK=true \
node wrapper/test/multiendpoint-live.mjs
```

`DERPC_DEV_ORIGIN` defaults to `http://localhost:5173`; `DERPC_BROWSER_PATH`, `DERPC_TEST_TOR_IMAGE` and `DERPC_TEST_REPORT` can override their defaults. The report normally goes to `/tmp/derpc-multiendpoint-live.json`. The optional ENS stage resolves the fully on-chain `derpc.eth` `url` record and reports its outcome separately from endpoint failover. The runner checks shutdown and source hashes and removes its owned wrappers, Tor container, browser and temporary files. It does not modify the existing gateway or operator services.

These are same-party proxies to a public upstream under a mock name. The test does not register ENS names, establish independent node ownership, prove sustained uptime or activate payments. Readiness timings are separate from failover timings; a node that previously failed may correctly be skipped while it is cooling down. Review the local report before publishing a sanitized copy.

The [November 6 saved check](test/multiendpoint-evidence-2026-11-06.json) passed at authenticated mainnet block 26356914. Both nodes served, the forced node-b failure recovered through node-a in 14.605 seconds, and the same account retained node-a. After a separate explicit selection, MEV Blocker supplied the cross-operator fallback in 3.103 seconds. Generic ENS resolution also passed in 26.489 seconds with no remote `eth_call`. Shutdown caused zero subsequent calls, source hashes remained unchanged, and all owned temporary resources were removed. The report retains earlier availability failures and the warmup precondition; these timings are observations, not performance guarantees.

### Local container payment check

After producing a fresh live-browser report, run this from the repository root with loopback ports 18545 and 18787 available:

```sh
docker build -f wrapper/Dockerfile -t derpc-wrapper-paid-check .
DERPC_TEST_HEADER_REPORT=/tmp/derpc-wrapper-live.json node wrapper/test/paid-container.mjs
```

This checks the built image with a temporary Ganache escrow, throwaway settlement key and isolated voucher-state volume. It rejects an unauthenticated paid proof, verifies a real mainnet proof against the earlier browser-authenticated root, preserves the accepted voucher across a container restart, and checks one local closing payment/refund. It removes its temporary resources afterward. The [saved packaging result](test/payment-container-evidence-2026-11-06.json) paid 10 local test wei and refunded 9,990. The wrapper connection here is loopback and the settlement chain is local; this is not a public deployment or an anonymous browser payment run.
