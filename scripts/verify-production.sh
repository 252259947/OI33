#!/usr/bin/env bash

set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work_dir=$(mktemp -d /tmp/oi33-production-check.XXXXXX)

cleanup() {
    case "$work_dir" in
        /tmp/oi33-production-check.*) rm -rf -- "$work_dir" ;;
    esac
}
trap cleanup EXIT

tar \
    --exclude=.git \
    --exclude=node_modules \
    --exclude=dist \
    -C "$repo_dir" -cf - . | tar -C "$work_dir" -xf -

cd "$work_dir"
yarn install --production --non-interactive --ignore-scripts
node -e "require('nunjucks'); require('schemastery');"

esbuild_bin=$(command -v esbuild || true)
if [[ -z "$esbuild_bin" && -x /usr/local/share/.config/yarn/global/node_modules/esbuild/bin/esbuild ]]; then
    esbuild_bin=/usr/local/share/.config/yarn/global/node_modules/esbuild/bin/esbuild
fi
if [[ -z "$esbuild_bin" ]]; then
    echo "esbuild is required for the frontend verification." >&2
    exit 1
fi

bundle_dir="$work_dir/frontend-bundles"
"$esbuild_bin" frontend/*.page.ts \
    --bundle \
    --platform=browser \
    --outdir="$bundle_dir" \
    --external:@hydrooj/ui-default \
    --log-level=warning

echo "Production dependency and frontend bundle checks passed."
