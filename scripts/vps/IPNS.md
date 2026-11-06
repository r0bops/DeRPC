# Stable website address

The dedicated IPNS key `derpc-website` on the VPS names:

```text
ipns://k51qzi5uqu5dip6ttqcmj10rokc1dq8ppmppbo05grxwha1yvabumx7k1k9jhc
```

Its initial target is the already published release:

```text
/ipfs/bafybeidksnvtvc7n4ciiflw7o2gc563lqaxtulmqix2cxvddvhc4sv24me
```

This name is derived from a dedicated Ed25519 publishing key. Reuse that key for
every update. It is separate from the IPFS node's `self` key and from the Ethereum
wallet. The [deployment record](../../web/deployment-ipns-2026-11-06.json) contains
the public signed record, independent resolution evidence and backup checks.

## One-time ENS change

The owner completed the one-time ENS change in transaction
`0x279ae1501ad3df887e4d470ce8423523e68628a147ff34091fac3248d8c51587`.
Two administrative RPC sources confirmed its successful canonical receipt and the
exact IPNS contenthash, with 18 confirmations at observation. All 55 website files
matched through `https://derpc.eth.limo/`; response headers identify the IPNS path
and expected release CID. See the [publication evidence](../../web/ens-ipns-publication-2026-11-06.json).
The agent sent no transaction. Keep the original release pinned for rollback.

Normal website-version updates now require IPNS publication rather
than an Ethereum transaction. The publishing key can change the website's JavaScript
without another Ethereum-wallet approval. Protecting it is therefore part of
protecting the host-side verifier users download. The ENS wallet and existing
resolver administrators retain their separate authority over the ENS pointer.

## Publish a later release

Build, check and pin the new release first, following the [site instructions](../../web/README.md#ensipfs-deployment).
Record the new CID and retain the prior pin. On the VPS, substitute the checked CID:

```sh
runuser -u derpc-ipfs -- env IPFS_PATH=/var/lib/derpc-ipfs \
  /opt/derpc/bin/ipfs pin ls --type=recursive NEW_CID
runuser -u derpc-ipfs -- env IPFS_PATH=/var/lib/derpc-ipfs \
  /opt/derpc/bin/ipfs --timeout=120s name publish \
  --key=derpc-website --lifetime=48h --ttl=5m /ipfs/NEW_CID
```

Check the name from a separate node with `ipfs name resolve --nocache /ipns/NAME`,
then compare the website bytes and run the HTTPS browser checks. A timed-out publish
can have partially succeeded; inspect the signed record before retrying. Do not
generate a replacement key to solve a network timeout. Caches may keep an older
version temporarily; the record TTL is five minutes, not a promise of instant
gateway propagation. The current GitHub workflow pins a CID; it does not yet perform
this IPNS publication step.

## Renewal and availability

Kubo 0.43.1 runs as `derpc-ipfs.service`, enabled at boot. Its explicit settings are:

```json
{
  "Ipns.RepublishPeriod": "4h",
  "Ipns.RecordLifetime": "48h",
  "Ipns.DelegatedPublishers": ["https://delegated-ipfs.dev/routing/v1/ipns"]
}
```

`Routing.Type` remains `auto`, preserving ordinary IPFS content discovery/providing.
The daemon republishes its latest locally published records, including named keys.
There is no timer that overwrites the site with a hard-coded initial CID. The HTTP
publisher relays signed public records; it receives no publishing private key and
cannot forge a new target. It is an availability dependency.

Initial native-DHT publication attempts timed out at 120 and 300 seconds. After an
explicit HTTP publisher and a daemon restart, publication succeeded. Two fresh
nodes resolved the expected CID, and the public record's signature, value, sequence,
TTL and expiry were checked. Some later DNS/TLS and routing lookups still timed out;
see the evidence rather than inferring continuous availability from one success.

Renewal is **configured, not observed across a complete four-hour cycle**. Native
DHT stalls can delay parallel publication completion. Monitor `journalctl -u
derpc-ipfs` and verify that the public signed record's expiry advances before its
48-hour validity ends. If needed, republish the **current checked CID**, never an
old hard-coded release, and verify it independently. The IPFS API stays loopback-only;
no wildcard CORS change was made.

Primary references: [Kubo configuration](https://github.com/ipfs/kubo/blob/v0.43.1/docs/config.md#ipns),
[IPNS behavior](https://docs.ipfs.tech/concepts/ipns/) and
[eth.limo IPNS publishing](https://eth-limo.gitbook.io/documentation/ipns-publishing/how-to-publish-to-ipns).

## Encrypted recovery copy

The key is stored in the service account's mode-0700 keystore. An age-encrypted
backup exists on the VPS at
`/var/lib/derpc-ipfs/ipns-backups/derpc-website-2026-11-06.key.age`, and on the operator's
machine at `~/.local/share/derpc/backups/derpc-website-ipns-2026-11-06.key.age`.
Both backup files have mode 0600. Encryption uses the operator's existing SSH
Ed25519 public key; recovery requires its corresponding private-key file. Neither
the publishing key nor the SSH private key is in this repository.

Recovery was tested in a temporary offline Kubo repository: decrypting and importing
the backup reproduced exactly the public IPNS name above. The temporary repository
was removed. The tested pipeline uses `-` for stdin on import:

```sh
set -o pipefail
age -d -i /path/to/owner-ssh-private-key /path/to/derpc-website.key.age |
  IPFS_PATH=/path/to/recovery-repo ipfs --offline key import derpc-website -
```

Use a protected, initialized recovery repository. Confirm the public name before
publishing. Preserve the recovered name and key when moving servers; generating a
new key creates a different IPNS address and would need another ENS update.
