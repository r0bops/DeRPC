#!/usr/bin/env bash
# Add an opt-in fault overlay to demo-2/demo-3 without replacing wrapper or onion keys.
set -euo pipefail
[[ $EUID == 0 && $# == 2 ]] || { echo 'Usage (root): install-demo-faults.sh demo-2.derpc.eth|demo-3.derpc.eth DEMO_SOURCE_DIR' >&2; exit 1; }
case "$1" in demo-2.derpc.eth|demo-3.derpc.eth) ;; *) echo 'Only demo-2 and demo-3 are permitted' >&2; exit 1 ;; esac
ens=$1
source_dir=$(realpath "$2")
app=/opt/derpc/app/wrapper
target=/opt/derpc/demo
control=/var/lib/derpc-demo-control
[[ -f $app/compose.yaml ]] || { echo 'Existing wrapper Compose deployment required' >&2; exit 1; }
for file in control.mjs proxy.mjs server.mjs; do
  [[ -f $source_dir/$file && ! -L $source_dir/$file ]] || { echo 'Missing demo source file' >&2; exit 1; }
done
image=$(docker inspect --format '{{.Image}}' wrapper-proxy-1)
[[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
before=$(docker exec wrapper-tor-1 cat /var/lib/tor/pool/hostname)
[[ $before =~ ^[a-z2-7]{56}\.onion$ ]] || exit 1
# Pin the existing Node image; no image pull, build, node replacement or new wallet is involved.
install -d -m 0755 "$target" "$target/files" "$control"
for file in control.mjs proxy.mjs server.mjs; do install -m 0644 "$source_dir/$file" "$target/files/$file"; done
printf '%s\n' "$image" > "$target/image-id"
docker exec wrapper-tor-1 cat /etc/tor/torrc > "$target/torrc.observed"
if [[ ! -f $target/torrc.original ]]; then install -m 0644 "$target/torrc.observed" "$target/torrc.original"; fi
[[ $(grep -c '^HiddenServicePort 80 127.0.0.1:8787$' "$target/torrc.original") == 1 ]] || { echo 'Unexpected Tor ingress configuration' >&2; exit 1; }
sed 's/^HiddenServicePort 80 127.0.0.1:8787$/HiddenServicePort 80 127.0.0.1:8790/' "$target/torrc.original" > "$target/torrc"
cat > "$target/control.sh" <<'CONTROL'
#!/usr/bin/env bash
set -euo pipefail
image=$(cat /opt/derpc/demo/image-id)
[[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
exec docker run --rm --network none --read-only --user 0 --cap-drop ALL --security-opt no-new-privileges \
  --mount type=bind,src=/opt/derpc/demo/files,dst=/app/wrapper/demo,readonly \
  --mount type=bind,src=/var/lib/derpc-demo-control,dst=/control \
  -e DERPC_DEMO_CONTROL_FILE=/control/scenario.json "$image" node demo/control.mjs "$@"
CONTROL
chmod 0755 "$target/control.sh"
"$target/control.sh" off
cat > "$target/compose.yaml" <<COMPOSE
services:
  demo-fault:
    image: $image
    pull_policy: never
    command: [node, demo/server.mjs]
    working_dir: /app/wrapper
    user: "1000:1000"
    network_mode: host
    environment:
      DERPC_DEMO_FAULTS: "true"
      DERPC_ENS_NAME: "$ens"
    volumes:
      - /opt/derpc/demo/files:/app/wrapper/demo:ro
      - /var/lib/derpc-demo-control:/control:ro
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    pids_limit: 64
    mem_limit: 192m
    restart: unless-stopped
  tor:
    volumes:
      - /opt/derpc/demo/torrc:/etc/tor/torrc:ro
COMPOSE
compose=(docker compose --project-directory "$app" -p wrapper -f "$app/compose.yaml" -f "$target/compose.yaml")
"${compose[@]}" up -d --no-deps --no-build --pull never --force-recreate demo-fault
healthy=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8790/.well-known/derpc-demo.json > "$target/status.json"; then healthy=true; break; fi
  sleep 1
done
[[ $healthy == true ]] || { echo 'Overlay failed to start; Tor has not been redirected' >&2; exit 1; }
"${compose[@]}" up -d --no-deps --no-build --pull never tor
after=$(docker exec wrapper-tor-1 cat /var/lib/tor/pool/hostname)
[[ $after == "$before" ]] || { echo 'Unexpected onion identity change; investigate before use' >&2; exit 1; }
echo "Installed default-off fault overlay for $ens; pool onion identity preserved: $after"
"$target/control.sh" status
