#!/usr/bin/env bash
# Forced command for the release pipeline's deploy key: read one CAR from stdin, import it into the
# local IPFS node and pin its root. The key can do nothing else on this host.
#
# Install as /opt/derpc/bin/derpc-pin-car (root-owned, 0755) and bind the key to it in the deploy
# user's ~/.ssh/authorized_keys:
#   command="/opt/derpc/bin/derpc-pin-car",restrict ssh-ed25519 AAAA... derpc-release
# The client sends the expected root CID as its SSH command:
#   ssh derpc-deploy@HOST bafybei... < site.car
set -euo pipefail
umask 077

expected=${SSH_ORIGINAL_COMMAND:-}
# CIDv1, dag-pb, sha2-256, base32: the only root the packaging script produces.
if [[ ! $expected =~ ^bafybei[a-z2-7]{52}$ ]]; then
  echo 'usage: ssh DEPLOY_USER@HOST <root CIDv1> < site.car' >&2
  exit 64
fi

ipfs=(/opt/derpc/bin/ipfs --api /ip4/127.0.0.1/tcp/5001)
max_bytes=$((64 * 1024 * 1024))
car=$(mktemp)
trap 'rm -f "$car"' EXIT

head -c "$((max_bytes + 1))" > "$car"
size=$(stat -c %s "$car")
if (( size == 0 || size > max_bytes )); then
  echo "refused: CAR is $size bytes; expected 1 to $max_bytes" >&2
  exit 65
fi

pinned_before=$("${ipfs[@]}" pin ls --type=recursive --quiet)
roots=$("${ipfs[@]}" dag import --pin-roots=true "$car" | awk '$1 == "Pinned" && $2 == "root" { print $3 }')
if [[ $roots != "$expected" ]]; then
  # Never keep a pin for content the caller did not name, and never remove one that was already here:
  # a mismatched upload must not be able to unpin a published release.
  for root in $roots; do
    grep -qxF "$root" <<<"$pinned_before" || "${ipfs[@]}" pin rm "$root" >/dev/null 2>&1 || true
  done
  echo "refused: CAR root(s) '${roots//$'\n'/ }' do not match $expected" >&2
  exit 66
fi

"${ipfs[@]}" pin ls --type=recursive "$expected" >/dev/null
# Tell the network this node has the content. Slow networks should not fail a completed pin.
timeout 90 "${ipfs[@]}" routing provide "$expected" >/dev/null 2>&1 || echo 'note: provider announcement did not finish; the node will retry on its own' >&2
echo "pinned $expected ($size bytes)"
