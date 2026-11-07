# GitHub website releases

The release workflow publishes the website on pushes to `main`. Pull requests run
CI without deployment access. A manual run of `release-ens.yml` on `main` can also
publish or, with `publish` disabled, only package the release. Neither path needs
an Ethereum transaction: `derpc.eth` keeps its existing IPNS contenthash.

The VPS command and GitHub environment are configured. The [readiness evidence](../../web/deployment-github-ipns-2026-11-06.json)
records a live rehearsal of the current CID, independent IPFS/HTTPS retrieval and
the remaining first complete Actions-run gate. A local rehearsal is not a GitHub
deployment. The user explicitly authorized committing and pushing the verifier
fixes after the failure investigation.

## Release sequence

1. Type-check, test, build with the explicit public gateway, and check the static
   release. Package a CAR and file-hash manifest with pinned Kubo 0.43.1.
2. Bind the artifact to the exact clean source commit, expected CID, CAR size and
   checksum. Upload through the restricted SSH command.
3. The VPS validates the CAR in an isolated offline repository, including its one
   root and complete DAG. It imports only that root's canonical DAG and retains old pins.
4. A fresh verifier retrieves the CID over IPFS and hashes every file. It explicitly
   connects to the VPS and uses auto routing; it does not claim exclusive delivery
   from that peer or automatic discovery. Timed-out connect, directory-list and
   file-read operations make at most three attempts on the same isolated node, with
   20-second backoff, 30-second requests and the existing eight-minute total budget.
   Invalid entries, size/hash mismatches and other errors still stop immediately.
   The provider-listing check is advisory.
5. Recheck the current GitHub `main` SHA. If it changed, leave the CID pinned and
   stop. Otherwise ask the VPS to publish the fixed `derpc-website` IPNS name.
6. Verify the exact accepted release tuple on the VPS, the public record's signature,
   target and expiry, and every normal HTTPS URL's file hash and IPNS path. If an
   unchanged asset retains an older root header, also fetch its release-specific
   query URL and require the same hash, exact IPNS path and new root CID. Both
   responses count against the byte budget; evidence preserves both sets of headers.
   Keep receipts and verification reports as GitHub artifacts for 90 days.

The deployment key can request pins and publication of this website. Treat access
to it, the production workflow and `main` as authority to change downloaded
application/verifier code. It has no shell, sudo, forwarding, arbitrary Kubo
commands or direct key export. The actual IPNS key stays in the IPFS service's keystore.

## Installed access and configuration

After installing the gateway/IPFS services, run `scripts/vps/install-release.sh`
as root on the VPS. It installs the root-owned Python helper and shell wrapper,
preserves the existing authorized keys and IPNS identity, and creates
`/var/lib/derpc-release` owned by `derpc-deploy` with mode 0700.
The deploy home and SSH directory are root-owned. Its `authorized_keys` is
root-owned mode 0644: public and readable for SSH authentication, with writes
reserved to root. Bind the deploy public key to:

```text
restrict,command="/opt/derpc/bin/derpc-pin-car" ssh-ed25519 AAAA... derpc-release
```

The existing `DERPC_PIN_SSH_KEY` secret was reused. No private key belongs in this
repository. `ens-production` now allows only the `main` branch; no approval timer
or reviewer was added. Repository administrators retain their normal authority.

| Setting | Location | Purpose |
| --- | --- | --- |
| `DERPC_TOR_GATEWAYS` | Repository variable | Public visitor gateway compiled into the release |
| `DERPC_ENS_DIRECTORY` | Optional repository variable | Reviewed mainnet ENS registry, registrar runtime hash and expected subregistry pins as JSON |
| `DERPC_PIN_HOST` | `ens-production` variable | `derpc-deploy@45.76.81.48` |
| `DERPC_PIN_KNOWN_HOSTS` | `ens-production` variable | Independently checked SSH host key |
| `DERPC_PIN_PEER_ID` | `ens-production` variable | Advisory public provider lookup |
| `DERPC_PIN_SSH_KEY` | `ens-production` secret | Restricted SSH credential, never an Ethereum or IPNS key |

Leave `DERPC_ENS_DIRECTORY` unset until the operator deployment has a checked manifest. To prepare its public JSON from the receipt-verified manifest:

```sh
node --input-type=module -e 'import fs from "node:fs"; const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(m.kind!=="derpc-ens-deployment" || m.chainId!==1 || m.localOnly!==false || !m.verification?.receipts || !m.verification?.stateMatchesConfig) throw new Error("Require a checked public mainnet deployment manifest"); console.log(JSON.stringify({chainId:1,ethRegistry:m.upstream.ETHRegistry.address,registrar:{address:m.registrar.address,codeHash:m.registrar.codeHash,registry:m.subregistry}}));' /tmp/derpc-ens-manifest.json
```

For a local build and offline check, pass that same JSON as `VITE_ENS_DIRECTORY` alongside `VITE_TOR_GATEWAYS`. Invalid or incomplete pins fail the build. The dashboard prefills and locks the deployment pins, requires proven records, and waits for an explicit refresh and operator choice. Builds without pins retain manual configuration. Every release emits `demo/ens-directory.json` containing the canonical pins or `null`; the offline check binds it to the configured pins and compiled runtime, and IPFS packaging hashes it with the other assets. These checks do not prove current admission or records: the browser must prove both at a finalized block after deployment.

Declare gateways owned by the operators in their ENS records. A team-owned gateway cannot serve the team's registered demo proxies under the current ownership guard; choose a separately operated gateway for that integration. Multiple gateway entries are shuffled, so mixing the conflicting gateway into the list does not establish a safe primary/backup order.

## Retries and recovery

The first automatic run, [42305110614](https://github.com/r0bops/DeRPC/actions/runs/42305110614),
passed packaging and VPS pinning but timed out on its first root-directory read
after connecting to the public peer. The original pinned verifier had no retries;
IPNS publication was skipped. A later fresh-node check retrieved and hashed all 55
files from that same CID. This identifies an availability timeout, not a failed
build or rejected credential; the underlying network delay was not established.
The timeout retries above address the early failure while preserving every
integrity gate. Retry evidence records the operation, path, attempt and outcome.

The subsequent run, [42307096196](https://github.com/r0bops/DeRPC/actions/runs/42307096196),
passed native retrieval and published the new IPNS target, but its HTTPS check
failed repeatedly on the unchanged CSS file's old `X-Ipfs-Roots` header. Its bytes
already matched the new manifest; a request with `?derpc-release=<expected-CID>`
returned identical bytes with the new root. The updated verifier checks the normal
URL's bytes first, then verifies that fresh binding when necessary. Wrong bytes at
the normal URL cannot be hidden by the query response. All 55 live files passed
with the fix locally; neither failed Actions run contains it. The user subsequently
authorized committing and pushing the fixes. [Run 42310022450](https://github.com/r0bops/DeRPC/actions/runs/42310022450)
completed successfully with those fixes, and the later [d90cc742 release](https://github.com/r0bops/DeRPC/actions/runs/42314676419)
also passed. This resolves the earlier Actions acceptance gate; each new release
still needs verification against its own source commit and CID.

Workflow concurrency avoids overlapping releases, but does not establish commit
order. The VPS also locks operations and fsyncs the accepted run number, run ID,
source SHA, CAR hash and CID **before** calling IPNS publish. Older run numbers and
conflicting retries are rejected. An exact retry may republish. The run ID identifies
a run; only the per-workflow run number establishes ordering. Keep the workflow
file identity; recreating it with a reset run counter requires deliberate operator repair.

A publish timeout does not establish that nothing changed: Kubo can save a signed
record before its network calls finish. This occurred in the live rehearsal.
The workflow proceeds after such a timeout only if the VPS confirms the exact
accepted tuple; the public signature and every HTTPS file must still pass.
The renewed public record and all 55 files passed in the rehearsal. VPS acceptance,
publish acknowledgement and public verification remain distinct in the evidence.

Caches may retain a previous version for several minutes. The verifier waits within
an eight-minute total budget; it never combines partial successes from different
attempts. Failure does not unpin or automatically roll back. Inspect the uploaded
receipts first, then rerun the same Actions run if appropriate. An older run cannot
replace a later accepted release. To roll back deliberately, publish the desired
content through a new reviewed `main` release; retain the prior pins.

Manual root-side recovery is in [IPNS.md](IPNS.md). Coordinate it with Actions;
it bypasses the deployment helper's watermark. The checkpoint inside the website
still needs a trusted refresh before its startup expiry.

References: [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[environment restrictions](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
[Kubo publication](https://docs.ipfs.tech/reference/kubo/cli/#ipfs-name-publish).
