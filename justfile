# Warren's everyday commands. `just` on its own lists them.
#
# Deploying puts the built app on racknerd as https://warren.sentientmilieu.com. The server side
# - install.sh and the Caddy block with its basic auth - lives in ~/warren-deploy on the server
# and is not kept here, so the password hash stays off GitHub.

set shell := ["bash", "-euo", "pipefail", "-c"]

host := env_var_or_default("WARREN_HOST", "racknerd")
site := "https://warren.sentientmilieu.com"

# List the recipes
default:
    @just --list --unsorted

# Install the dependencies, exactly as locked
setup:
    npm ci

# Run the app in development, reloading on save
dev:
    npm run dev

# Hold a project for the app and the command line together: just serve house.warren.json
serve file *args:
    node bin/warren.ts serve {{file}} {{args}}

# Typecheck
check:
    npm run --silent check

# Unit tests
test:
    npm test

# Drive the real app in headless Chromium
test-browser:
    npm run --silent test:browser

# Everything that has to pass before anything ships
verify: check test test-browser

# Build the static app into dist/
build:
    npm run --silent build

# Verify, build, upload and install: the whole deploy. Asks for the sudo password once, at the end
deploy: verify upload install

# Build and copy dist/ to the server, without installing it
upload: build
    #!/usr/bin/env bash
    set -euo pipefail
    release=$(cat dist/version.txt)
    case "$release" in *-dirty) echo "warning: building $release — there are uncommitted changes in it";; esac
    rsync -a --delete dist/ "{{host}}:warren-deploy/dist/"
    echo "uploaded $release; install with: just install"

# Put what was uploaded live (needs a terminal: sudo asks for a password)
install:
    ssh -t {{host}} sudo ~/warren-deploy/install.sh
    @echo "live: $(cat dist/version.txt) — check with: just live"

# Which release the site is serving (asks for the friend's password)
live:
    curl -fsSu friend {{site}}/version.txt; echo
