#!/bin/sh
# Install root-owned as /opt/derpc/bin/derpc-pin-car, with release-site.py beside it.
# authorized_keys: restrict,command="/opt/derpc/bin/derpc-pin-car" ssh-ed25519 ...
# The helper retains the old bare-CID pin command; only explicit publish can sign.
set -eu
umask 077
exec /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C \
  SSH_ORIGINAL_COMMAND="${SSH_ORIGINAL_COMMAND-}" \
  /usr/bin/timeout --kill-after=5s 300s \
  /usr/bin/python3 -I /opt/derpc/bin/release-site.py
