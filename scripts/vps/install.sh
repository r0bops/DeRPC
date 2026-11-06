#!/usr/bin/env bash
# Initial installation on an inspected Ubuntu/systemd VPS. Verify both supplied
# binaries' hashes before running. Never downloads code or replaces identities.
set -euo pipefail

if [[ $# != 3 || $EUID != 0 ]]; then
  echo 'Usage (root): bash install.sh GATEWAY_BINARY IPFS_BINARY PUBLIC_IPV4' >&2
  exit 1
fi
gateway_binary=$(realpath "$1")
ipfs_binary=$(realpath "$2")
public_ipv4=$3
template_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
python3 - "$public_ipv4" <<'PY'
import ipaddress, sys
ip = ipaddress.ip_address(sys.argv[1])
if ip.version != 4 or not ip.is_global:
    raise SystemExit('Expected a public IPv4 address')
PY
"$gateway_binary" --help >/dev/null
"$ipfs_binary" version
for account in derpc-gateway derpc-ipfs; do
  if ! id "$account" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "/var/lib/$account" --shell /usr/sbin/nologin "$account"
  fi
  install -d -m 0700 -o "$account" -g "$account" "/var/lib/$account"
done
install -d -m 0755 /opt/derpc/bin /etc/derpc
install -m 0755 "$gateway_binary" /opt/derpc/bin/tor-js-gateway
install -m 0755 "$ipfs_binary" /opt/derpc/bin/ipfs
if [[ ! -e /etc/derpc/gateway.json ]]; then
  sed "s/PUBLIC_IPV4/$public_ipv4/g" "$template_dir/gateway.json" > /etc/derpc/gateway.json
  chmod 0644 /etc/derpc/gateway.json
fi
# Startup creates the identity if absent, under the unit's restrictive umask.
# The service account cannot edit the root-owned config or binaries.
runuser -u derpc-gateway -- /opt/derpc/bin/tor-js-gateway --config /etc/derpc/gateway.json show-config >/dev/null

ipfs_run() {
  runuser -u derpc-ipfs -- env IPFS_PATH=/var/lib/derpc-ipfs /opt/derpc/bin/ipfs "$@"
}
if [[ ! -f /var/lib/derpc-ipfs/config ]]; then
  ipfs_run init --profile=server
  ipfs_run config Addresses.API /ip4/127.0.0.1/tcp/5001
  ipfs_run config Addresses.Gateway /ip4/127.0.0.1/tcp/8080
  ipfs_run config --json Addresses.Announce "[\"/ip4/$public_ipv4/tcp/4001\",\"/ip4/$public_ipv4/udp/4001/quic-v1\"]"
  ipfs_run config Datastore.StorageMax 50GB
  ipfs_run config --json Swarm.ConnMgr.LowWater 64
  ipfs_run config --json Swarm.ConnMgr.HighWater 128
fi
install -m 0644 "$template_dir/derpc-gateway.service" /etc/systemd/system/derpc-gateway.service
install -m 0644 "$template_dir/derpc-ipfs.service" /etc/systemd/system/derpc-ipfs.service
systemd-analyze verify /etc/systemd/system/derpc-gateway.service /etc/systemd/system/derpc-ipfs.service
if command -v ufw >/dev/null; then
  # Do not reset the firewall or change SSH rules/default policy.
  ufw allow 12298/udp comment 'DeRPC Tor gateway'
  ufw allow 4001/tcp comment 'DeRPC IPFS swarm'
  ufw allow 4001/udp comment 'DeRPC IPFS swarm'
fi
systemctl daemon-reload
systemctl enable --now derpc-gateway.service derpc-ipfs.service
systemctl is-active derpc-gateway.service derpc-ipfs.service
