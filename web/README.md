# web

DeRPC site and operator directory. Vanilla TypeScript + Vite, Inter (self-hosted via
`@fontsource-variable/inter`), hash routing so it also loads from IPFS and `derpc.eth.limo`.

```
pnpm --filter web dev
pnpm --filter web build
```

The web dev server also serves the live dashboard at `/demo/`. `pnpm dev` runs the
standalone dashboard on port 5173 when needed. For deployment, run
`VITE_TOR_GATEWAYS='PUBLIC_IP:PORT:CERTHASH' pnpm build:site` with your real public gateway;
deploy `web/dist/`. The directory is at `/` and the verified-read demo is at `/demo/`.
`pnpm build:web` alone produces only the directory.

Pages: `#/` landing, `#/directory` (by operator or by network, shareable as
`#/directory?by=networks&q=base&verified=1`), `#/network/:id`, `#/operator/:ens`, `#/operate`.

## What is real

- `src/directory/operators.ts` lists the five operators from `provider/src/config` and the networks
  each one says it serves. Every network entry has a source link to the operator's own documentation.
- Only Ethereum mainnet (chain ID 1) is verified by DeRPC. Other networks are listed, labeled
  "not verified", and never marked as tested. `validateDirectory` in `src/directory/model.ts`
  enforces this.
- `provider/test/config/directory-sync.test.ts` fails if the directory and the provider's operator
  list drift apart.
- ENS names are mock (`ENS_NAMES_ARE_MOCK` in the provider) and are badged as such.
- The `/operate` page prepares a local operator/node draft and unsigned ENS configuration fragment; it does not register a name, check a live node or transact. Bounded multi-endpoint records and runtime routing are implemented; independent operators still need to publish their records. See [DEMO_WORKFLOW.md](../specs/DEMO_WORKFLOW.md).
- The live `/demo/` dashboard shows local observations from selected operators' reads. The static directory does not claim current health. Staking and operator pricing remain planned for the later paid rollout.

Brand assets are in `/brand`: Inter, lime, ink and white are primary; cobalt is secondary (never in the logo).

## ENS/IPFS deployment

The team's hosting choice is **`derpc.eth.limo`**, using the
[eth.limo gateway](https://eth.limo/). The site files live on IPFS; the `derpc.eth`
contenthash record now points to a stable IPNS name that resolves to the release CID. Both Vercel deployments and their project were removed
at the team's request. The [earlier deployment record](deployment-mainnet-alpha-2026-11-06.json)
is retained as historical evidence and explicitly marked removed.

The [current IPFS release](deployment-ens-ipfs-2026-11-06.json) is persistently
pinned on VPS `45.76.81.48` with its public Tor gateway. The frozen CAR and static
files are in `web/out/ens-ipfs-vps-only-2026-11-06/` (generated and ignored). All 55
files matched after retrieval through a fresh IPFS node. Firefox passed verified
reads and shutdown through the public gateway, with site delivery through local
Kubo. **The ENS website is now published and HTTPS-verified.** The owner's transaction,
all 55 HTTPS asset hashes and the fresh Firefox result are in the
[publication record](ens-website-publication-2026-11-06.json).
The original prepared CID, target and calldata are in the
[unsigned website transaction](ens-website-transaction-2026-11-06.json). Payments
remain off and the curated operator ENS names remain mock identifiers. This published CID predates the later integrated fixes; build and publish a new artifact, then repeat the hosted checks before claiming those fixes are live.

### Stable IPNS address

A dedicated publishing key on the VPS now provides:

```text
ipns://k51qzi5uqu5dip6ttqcmj10rokc1dq8ppmppbo05grxwha1yvabumx7k1k9jhc
```

It resolves to the same release CID. Independent resolution, signed-record checks
and encrypted-backup restoration passed; see [the evidence](deployment-ipns-2026-11-06.json).
**The one-time ENS Content hash switch is confirmed.** Two administrative RPC
sources checked the owner's receipt and record with 18 confirmations, without
claiming finalization. All 55 HTTPS files match and gateway headers identify the
IPNS path; fresh Firefox passed all 17 checks. See [publication evidence](ens-ipns-publication-2026-11-06.json).
Future releases reuse the key without another ENS transaction, so it authorizes
changes to downloaded application code. Renewal is
configured every four hours, but a full cycle has not yet been observed.
Follow the [IPNS runbook](../scripts/vps/IPNS.md) for publication, monitoring and recovery.

### Build and package an update

Build with the public Tor gateway address intended for visitors, then use a verified
[Kubo release](https://github.com/ipfs/kubo/releases) to package the static directory.
The initial package used Kubo 0.43.1, CIDv1, raw leaves and 262144-byte chunks.
Stop on any failed command. These commands create a local archive; they do not start
a public IPFS node or send an ENS transaction.

```sh
export VITE_TOR_GATEWAYS='PUBLIC_IP:PORT:CERTHASH'
pnpm build:site
node scripts/check-release.mjs --json
mkdir -p web/out
derpc_ipfs_repo="$(mktemp -d)"
IPFS_PATH="$derpc_ipfs_repo" ipfs init --profile=server
derpc_cid="$(IPFS_PATH="$derpc_ipfs_repo" ipfs --offline add --cid-version=1 --raw-leaves=true --chunker=size-262144 --recursive --quieter web/dist)"
IPFS_PATH="$derpc_ipfs_repo" ipfs --offline dag export "$derpc_cid" > web/out/site.car
```

The placeholder gateway must be replaced before building. Package only `web/dist/`;
keep source, `.env`, IPFS repository files and gateway keys outside the site. Relative
assets and hash routing support both an IPFS path and the ENS gateway domain. See
the [Kubo CLI reference](https://docs.ipfs.tech/reference/kubo/cli/#ipfs-dag-export).

### Publish and point ENS to it

1. Import the CAR into a persistent, online IPFS node or compatible pinning service.
   On a configured node, `ipfs dag import site.car` imports and pins its root; confirm
   the expected CID with `ipfs pin ls --type=recursive CID`. A local pin on a laptop
   alone does not establish durable public availability.
2. Retrieve `/`, `/demo/`, all referenced assets and the onboarding route through a
   public IPFS gateway. Compare bytes with the release manifest before changing ENS.
   For this release, third-party HTTPS previews were unavailable; a fresh native IPFS
   node retrieved every file instead. Repeat HTTPS checks on `derpc.eth.limo` after
   the signature before declaring the public website validated. This release has
   now passed those final HTTPS asset and browser checks.
3. For the active stable address, publish the checked CID under the existing
   `derpc-website` key using the [IPNS runbook](../scripts/vps/IPNS.md). The full
   `ipns://` URI above is already set as `derpc.eth`'s Content hash; preserve it.
   Later versions reuse that key without changing ENS. Choosing a direct `ipfs://CID`
   instead requires another ENS update whenever the CID changes.
4. Load `https://derpc.eth.limo/` and `/demo/` in a fresh browser. Check startup,
   verified finalized reads, rejection/failover and shutdown. A website HTTP 200
   does not complete the anonymous-read release gate.

The current ENSv2 resolver uses name-based setters and shared record bundles. The
administrative preflight and complete direct-link audit found an empty contenthash,
record ID 1 linked only to `derpc.eth`, and the owner's contenthash permission. An
existing contract administrator also has root record/upgrade/admin roles; the
prepared website update leaves those roles unchanged. The [ENS hosting guide](https://docs.ens.domains/dweb/intro/)
and [Permissioned Resolver documentation](https://docs.ens.domains/ensv2/permissioned-resolver/)
describe those interfaces. Direct CID changes require another ENS update; keep the
previous pinned CID available for rollback.

### Continuous integration and release pipeline

Two GitHub workflows prepare releases; neither sends a transaction or holds an ENS key.

- **`ci.yml`** runs on pull requests and on `main`: type check, every package's tests,
  `pnpm build:site`, the offline release check and IPFS packaging. The package is kept as
  a 7-day artifact, so each commit shows the CID it would publish. It builds with the
  public demonstration gateway only to exercise the release build.
- **`release-ens.yml`** is started by hand. It repeats those steps with the release
  gateway, sends the CAR to the team IPFS node, and compares all files fetched from
  public IPFS gateways with the manifest. Its summary gives the `ipfs://` URI and
  contenthash for the owner. If pinning or retrieval fails, it says not to change ENS.

Both use [`scripts/package-ipfs.mjs`](../scripts/package-ipfs.mjs), which applies the
packaging settings above and writes `web/out/ipfs-release/` (`site.car` and
`manifest.json`). Locally: `IPFS_BIN=/path/to/ipfs node scripts/package-ipfs.mjs` after
`pnpm build:site`, then `node scripts/verify-ipfs.mjs` once the CAR is pinned.

The workflows do not yet publish IPNS. After successful pinning and verification,
publish the new CID manually with the existing key as documented above. ENS now
uses IPNS; preserve that contenthash rather than replacing it with the workflow's
per-release `ipfs://` URI.

One-time setup, by the team:

| Where | Name | Value |
| --- | --- | --- |
| Repository variable | `DERPC_TOR_GATEWAYS` | Public gateway address(es) for visitors, `ip:port:certhash`, comma-separated |
| Environment `ens-production`, variable | `DERPC_PIN_HOST` | `deploy-user@host` of the IPFS node |
| Environment `ens-production`, variable | `DERPC_PIN_KNOWN_HOSTS` | That host's SSH host-key line, checked out of band |
| Environment `ens-production`, secret | `DERPC_PIN_SSH_KEY` | Private key used only by this workflow |

On the VPS, install [`scripts/vps/pin-car.sh`](../scripts/vps/pin-car.sh) as
`/opt/derpc/bin/derpc-pin-car` and bind the workflow's public key to it for an
unprivileged deploy user:

```
command="/opt/derpc/bin/derpc-pin-car",restrict ssh-ed25519 AAAA... derpc-release
```

That key gets no shell. It can upload one CAR of at most 64 MiB whose root matches the
CID it names; a mismatch is refused and never removes an existing pin. Add required
reviewers to the `ens-production` environment to approve each release. The workflow
has not run on GitHub yet, and the deploy user and key are not set up.

### VPS responsibilities

The same VPS can run a persistent IPFS node for the website and `tor-js-gateway`
for RPC transport as separate services. Visitors access the website through
`derpc.eth.limo`; the browser connects to the Tor gateway's advertised IP, UDP port
12298 and stable certificate hash. Changing website hosting does not fix that
gateway's reachability. Keep independent operator RPC services separate from the
gateway for the intended ownership separation.

Use separate service accounts and persistent data directories. Keep the IPFS
administrative API on loopback. Both services and the public pin are installed; see
the [VPS runbook](../scripts/vps/README.md) and
[deployment evidence](deployment-vps-2026-11-06.json). Release builds use exactly the
configured gateway list, without adding the upstream demonstration instance.
