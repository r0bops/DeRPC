# DeRPC operator release

This archive contains prebuilt wrapper and Tor Docker images for one Linux CPU
architecture. Docker Engine with Compose v2, Bash and coreutils are required.
Node, pnpm, a source checkout and an image-registry account are not required.
The wrapper serves free mainnet reads. Payments and staking are not enabled.

1. Download the archive and its `.sha256` file from the same GitHub release.
   Run `sha256sum --check <archive-name>.sha256` before extracting the archive.
2. Extract it and enter the extracted directory. Run `./derpc-wrapper install`.
3. Edit `.env`: set your operator ENS name, public signer address, stable node ID,
   and your execution and beacon API URLs. Never put a private key in this file.
4. Run `./derpc-wrapper up`, then `./derpc-wrapper check` after Tor and your nodes
   are ready. A failed readiness check can be retried without restarting the stack.

The execution node must serve a proof and code at its finalized mainnet block.
The consensus node must serve light-client bootstrap, updates, finality and
optimistic-update routes. Keep both node APIs on loopback. The wrapper also binds
to loopback; Tor is the public ingress. The host needs free port 8787.
Set `DERPC_DEMO_PROXY=true` if you intentionally proxy somebody else's public nodes;
that does not establish operator independence.

`check` runs inside the wrapper container. It checks a finalized proof response
and beacon finality update and prints an unsigned ENS endpoint proposal. It does
not register the name, publish records, prove public onion reachability or verify
answers for clients. Clients still need DeRPC's Anon-RPC transport and host-side
verification. Merge the proposed node into the operator's complete endpoint list
before publishing ENS records, preserving sibling nodes. Test the resulting onion
through the browser's pinned Anon-RPC worker separately.

Use `./derpc-wrapper status` or `./derpc-wrapper logs` to inspect the stack.
`./derpc-wrapper down` stops it without deleting keys. The Compose project is
always `derpc-wrapper`; the `derpc-wrapper_onion-keys` volume holds the onion
identity. Back it up securely before upgrades. This release does not migrate keys
from older source-based deployments or other Compose projects automatically.

For an upgrade, verify and extract the new archive, copy your existing `.env`
without publishing it, run its `install`, then `up` and `check`. Keep the same
Docker host and project so the existing key volume is reused. Do not run two
release directories concurrently. Retain the prior archive for rollback; never
use `docker compose down --volumes` or remove the key volume during an upgrade.

`build-info.json` identifies the source revision, image IDs and build platform.
`verification.json` records offline container checks; it is not a live network
or ENS enrollment claim. SHA-256 checksums detect changed downloads; obtain the
archive and checksum from the project's trusted release page.
