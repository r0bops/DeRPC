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
contenthash record points to their root CID. Both Vercel deployments and their project were removed
at the team's request. The [earlier deployment record](deployment-mainnet-alpha-2026-11-06.json)
is retained as historical evidence and explicitly marked removed.

The [prepared IPFS release](deployment-ens-ipfs-2026-11-06.json) contains the CID,
ENSIP-7 contenthash bytes, asset hashes and validation results. Its local CAR and
static archive are in `web/out/ens-ipfs-2026-11-06/` (generated and ignored).
**This is a prepared package, not a published ENS website:** durable public pinning
and the owner-signed ENS update are still pending. Payments remain off, ENS operator
names remain mock, and the compiled demonstration gateway still lacks a successful
hosted startup check.

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
3. Use the [ENS app](https://app.ens.domains/) to set `derpc.eth`'s contenthash to
   `ipfs://CID`, using the owner's wallet on Ethereum mainnet. Review the target name,
   CID and fee, then verify the transaction receipt and read the record back. The
   prepared record is not authorization to change a different name or resolver.
4. Load `https://derpc.eth.limo/` and `/demo/` in a fresh browser. Check startup,
   verified finalized reads, rejection/failover and shutdown. A website HTTP 200
   does not complete the anonymous-read release gate.

The current ENSv2 resolver uses name-based setters and shared record bundles. The
administrative preflight found an empty contenthash, record ID 1, and the expected
owner's contenthash permission; shared links still need checking before preparing
the final transaction. The [ENS hosting guide](https://docs.ens.domains/dweb/intro/)
and [Permissioned Resolver documentation](https://docs.ens.domains/ensv2/permissioned-resolver/)
describe those interfaces. Direct CID changes require another ENS update; keep the
previous pinned CID available for rollback.

### VPS responsibilities

The same VPS can run a persistent IPFS node for the website and `tor-js-gateway`
for RPC transport as separate services. Visitors access the website through
`derpc.eth.limo`; the browser connects to the Tor gateway's advertised IP, UDP port
12298 and stable certificate hash. Changing website hosting does not fix that
gateway's reachability. Keep independent operator RPC services separate from the
gateway for the intended ownership separation.

Use separate service accounts and persistent data directories. Keep the IPFS
administrative API on loopback. Gateway/IPFS installation and the public pin await
the team's existing VPS details.
