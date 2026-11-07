#!/usr/bin/env bash
# Install a DeRPC demonstration proxy on an Ubuntu 24.04 host: the operator wrapper in demo-proxy
# mode in front of public execution and beacon services. A demo proxy is run by the team and labels
# itself `demo-proxy`; it is not an independent operator.
#
# Usage (root): bash install-demo-proxy.sh ENV_FILE
# ENV_FILE sets DERPC_ENS_NAME, DERPC_SIGNER, DERPC_EXECUTION_URL, DERPC_BEACON_URL and
# DERPC_DEMO_PROXY=true (see wrapper/README.md). It is copied to the wrapper as its .env file, so
# `docker compose` restarts keep the same settings. Re-running the script updates the checkout and
# the containers; the onion identity lives in the `onion-keys` Docker volume and is kept.
set -euo pipefail

if [[ $# != 1 || $EUID != 0 ]]; then
  echo 'Usage (root): bash install-demo-proxy.sh ENV_FILE' >&2
  exit 1
fi
env_file=$(realpath "$1")
app=/opt/derpc/app
repo_url=https://github.com/r0bops/DeRPC
repo_ref=main
node_version=24.16.0
node_sha256=d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9

for name in DERPC_ENS_NAME DERPC_SIGNER DERPC_EXECUTION_URL DERPC_BEACON_URL; do
  grep -q "^$name=" "$env_file" || { echo "$env_file must set $name" >&2; exit 1; }
done
grep -q '^DERPC_DEMO_PROXY=true$' "$env_file" || { echo "$env_file must set DERPC_DEMO_PROXY=true: this installer is for demonstration proxies only" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends docker.io docker-compose-v2 git curl xz-utils ca-certificates
systemctl enable --now docker

# Node 24 is only needed by the wrapper's setup command; the proxy itself runs in a container.
if ! command -v node >/dev/null || [[ $(node --version) != "v$node_version" ]]; then
  archive="node-v$node_version-linux-x64.tar.xz"
  curl -fsSL --retry 3 -o "/tmp/$archive" "https://nodejs.org/dist/v$node_version/$archive"
  echo "$node_sha256  /tmp/$archive" | sha256sum --check --strict
  tar -xJf "/tmp/$archive" -C /usr/local --strip-components=1
  rm -f "/tmp/$archive"
fi
corepack enable
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

if [[ -d $app/.git ]]; then
  git -C "$app" fetch --depth 1 origin "$repo_ref"
  git -C "$app" checkout -q --force FETCH_HEAD
else
  install -d -m 0755 /opt/derpc
  git clone --depth 1 --branch "$repo_ref" "$repo_url" "$app"
fi
echo "Deploying $(git -C "$app" rev-parse --short HEAD) from $repo_url ($repo_ref)"

install -m 0600 "$env_file" "$app/wrapper/.env"
cd "$app"
pnpm --filter @derpc/wrapper... install --frozen-lockfile --prod --ignore-scripts

set -a
# shellcheck disable=SC1090
. "$app/wrapper/.env"
set +a
# Builds the images, starts the stack, checks a finalized proof and a beacon finality update
# through the local wrapper, then prints the records to publish (including the onion address).
pnpm --filter @derpc/wrapper run setup 2>&1 | tee /var/log/derpc-wrapper-setup.log
docker compose -f "$app/wrapper/compose.yaml" ps
