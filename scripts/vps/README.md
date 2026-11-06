# DeRPC gateway and IPFS host

These files install two system services on an already inspected Ubuntu VPS. The
November 6 alpha uses `45.76.81.48` (`derpc-vps` in the operator's local SSH config).
SSH credentials and both service identities stay outside this repository.

The VPS serves the encrypted Tor entry transport and IPFS blocks. The browser
loads the website through `derpc.eth.limo`; it verifies RPC answers on the user's
device. This host does not run an execution/beacon node or enroll an operator.
Payments remain disabled.

## Initial installation

Inspect existing services, ports, firewall rules, disk and available memory first.
The installed server is Ubuntu 26.10, x86_64, 4 vCPUs, about 7.2 GiB usable memory
and a 150 GiB root filesystem. Ubuntu 24.04 LTS was the earlier recommendation;
the supplied server was retained. Port 22 was already allowed by UFW.

Supply a trusted, compatible `tor-js-gateway` binary and an officially verified
Kubo binary. The deployed gateway was built locally from upstream tor-js v0.4.4,
commit `d9d9612d10d3775ff100b70e96a291718191d856` (gateway crate 0.3.0).
Its dynamic libraries and command execution were checked on the VPS before install.

| Artifact | SHA-256 |
| --- | --- |
| Gateway binary | `bb70cd879a763c7b9348cc33c228c467baa07d0106471783d9ba65939393818f` |
| Kubo 0.43.1 Linux amd64 release archive | `3f2bf974ab2a3ec6d997fac7d8cb46f59983a7cddd0b55ef998e6ce379155fb2` |
| Extracted `ipfs` binary | `8768c8a2907f429f177917091e8abe250d3368d1b82ea0348332cf7e53807bf0` |

The Kubo archive hash was compared with the official GitHub release metadata.
These gateway binary bytes are a recorded local build, not an upstream signature
or a reproducible-build claim. Review and rebuild deliberately when upgrading.

Copy this directory and the verified binaries to the host, then run as root:

```sh
bash /var/tmp/derpc-vps-install/install.sh \
  /var/tmp/tor-js-gateway /var/tmp/ipfs 45.76.81.48
```

The installer creates `derpc-gateway` and `derpc-ipfs`, installs root-owned binaries
under `/opt/derpc/bin`, and enables both units at boot. It preserves existing
configuration and identities; this is an initial installer, not a rolling update
tool. For updates, stop only the affected service before replacing its binary,
then restart and repeat the public checks.

UFW allows UDP 12298 for KPS and TCP/UDP 4001 for IPFS. Existing SSH rules and
default policy are preserved. A separate provider firewall must also permit these
ports if enabled. IPFS API port 5001 and HTTP gateway port 8080 bind to loopback.

## State and limits

- Gateway config: `/etc/derpc/gateway.json`; identity: `/var/lib/derpc-gateway/kps.key`.
  Its certificate hash must remain stable across restarts. Losing this identity
  requires a new frontend build with the new gateway address.
- IPFS repository: `/var/lib/derpc-ipfs`. Its config contains a private identity;
  do not print or commit it. Preserve the repository and pins during upgrades.
- Gateway: 1 GiB soft / 2 GiB hard memory limit; 1024 total tunnels and 16 per
  client IP. IPFS: 3 GiB soft / 4 GiB hard limit, 64–128 target peers and 50 GB
  garbage-collection storage target. These are initial limits, not load-test results.
- The gateway advertises `demo: true` while this is an alpha. Routine CONNECT
  messages containing client IPs are suppressed; operational warnings can still
  contain connection metadata. This is not a claim that the gateway cannot see IPs.

Service restarts preserve on-disk state; they are not backups. Arrange encrypted
off-host backups and a second persistent pin before claiming redundant hosting.
The dedicated website IPNS key now has a tested encrypted off-host backup; this
does not back up the full IPFS repository or the gateway identity. Its stable
address, renewal settings and recovery steps are in [IPNS.md](IPNS.md).

## Publish a release

Build and check the site using the exact public address printed by the gateway.
Release builds use only explicitly configured gateways. Multiple entries are a
worker selection pool, not a guaranteed primary/backup ordering.

```sh
export VITE_TOR_GATEWAYS='45.76.81.48:12298:uEiDF_BrtBaFV_aXYw0Eo4OY73zCVlT96GTYm-wNqYiDopg'
pnpm build:site
node scripts/check-release.mjs --json
```

Follow [the IPFS packaging instructions](../../web/README.md#ensipfs-deployment).
Copy the generated CAR to the VPS and import with its service account:

```sh
runuser -u derpc-ipfs -- env IPFS_PATH=/var/lib/derpc-ipfs \
  /opt/derpc/bin/ipfs dag import /var/tmp/site.car
runuser -u derpc-ipfs -- env IPFS_PATH=/var/lib/derpc-ipfs \
  /opt/derpc/bin/ipfs pin ls --type=recursive CID
```

Compare the CID and CAR checksum with the release manifest, retrieve every asset
through an external IPFS gateway, and run the real Firefox verified-read checks.
For a direct IPFS contenthash, only then prepare the owner's ENS transaction.
The stable IPNS name is active in ENS, with the owner-signed switch verified.
Publish new CIDs with the existing `derpc-website` key using
[IPNS.md](IPNS.md), then verify public delivery. Keep earlier published releases
pinned until the replacement works. A local pin or HTTP 200 alone does not
establish a working anonymous RPC path.

## Operations

```sh
systemctl status derpc-gateway derpc-ipfs
journalctl -u derpc-gateway -u derpc-ipfs --since '10 minutes ago'
systemctl is-enabled derpc-gateway derpc-ipfs
```

Restart an affected service with `systemctl restart SERVICE`. Confirm its identity
and pins afterward. Do not expose the IPFS administrative API to debug retrieval.
The checkpoint baked into the November 6 build expires November 12 at 17:07:35 UTC;
refresh it through the documented trusted-checkpoint process and publish a new CID
before then.
