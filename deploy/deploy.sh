#!/usr/bin/env bash
# Builds Warren and puts it on racknerd as https://warren.sentientmilieu.com.
#   deploy/deploy.sh             build, upload, install (asks for the sudo password once)
#   deploy/deploy.sh --upload    build and upload only; install later with
#                                ssh -t racknerd sudo ~/warren-deploy/install.sh
# The server side - install.sh and the Caddy block with its basic auth - lives in
# ~/warren-deploy on the server and is not kept here, so the password hash stays off GitHub.
set -euo pipefail
HOST=${WARREN_HOST:-racknerd}
cd "$(dirname "$0")/.."

npm run --silent build
rsync -a --delete dist/ "$HOST:warren-deploy/dist/"
if [[ "${1:-}" == "--upload" ]]; then
  echo "uploaded; install with: ssh -t $HOST sudo ~/warren-deploy/install.sh"
  exit 0
fi
ssh -t "$HOST" sudo ~/warren-deploy/install.sh
