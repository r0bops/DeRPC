#!/usr/bin/env bash
# Install/update the restricted release command; preserves authorized_keys and IPNS state.
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run as root on the IPFS VPS.' >&2; exit 1; }
test -x /opt/derpc/bin/ipfs || { echo 'Install the IPFS service first.' >&2; exit 1; }
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! id derpc-deploy >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/derpc-deploy --shell /bin/sh derpc-deploy
fi
test "$(id -u derpc-deploy)" != 0
for directory in /home/derpc-deploy /home/derpc-deploy/.ssh /var/lib/derpc-release; do
  test ! -L "$directory" || { echo "Refusing symlink: $directory" >&2; exit 1; }
done
install -d -o root -g root -m 0755 /home/derpc-deploy
install -d -o root -g root -m 0755 /home/derpc-deploy/.ssh
install -d -o derpc-deploy -g derpc-deploy -m 0700 /var/lib/derpc-release
if test -e /home/derpc-deploy/.ssh/authorized_keys; then
  test ! -L /home/derpc-deploy/.ssh/authorized_keys
  chown root:root /home/derpc-deploy/.ssh/authorized_keys
  # sshd checks this file as the login user. These are public keys; root owns writes.
  chmod 0644 /home/derpc-deploy/.ssh/authorized_keys
fi
install -o root -g root -m 0755 "$source_dir/release-site.py" /opt/derpc/bin/release-site.py
# Atomic replacement keeps existing SSH sessions on the old command intact.
install -o root -g root -m 0755 "$source_dir/pin-car.sh" /opt/derpc/bin/derpc-pin-car.new
mv /opt/derpc/bin/derpc-pin-car.new /opt/derpc/bin/derpc-pin-car
echo 'Restricted command installed. Keep the deploy public key bound to restrict,command="/opt/derpc/bin/derpc-pin-car".'
echo 'The existing IPNS identity and pins were not changed.'
