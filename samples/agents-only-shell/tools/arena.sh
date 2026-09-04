#!/usr/bin/env bash
# Clone the shell into .arena/candidate-N workspaces, each on its own port.
# Kept at the same directory depth as samples/agents-only-shell so the
# ../../../packages/core import still resolves.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
src="$root/samples/agents-only-shell"
n="${1:-3}"
base_port=4181

mkdir -p "$root/.arena"
for i in $(seq 1 "$n"); do
  dst="$root/.arena/candidate-$i"
  port=$((base_port + i - 1))
  rm -rf "$dst"
  mkdir -p "$dst"
  rsync -a --exclude node_modules --exclude out --exclude dist --exclude tsconfig.tsbuildinfo "$src/" "$dst/"
  ln -s "$src/node_modules" "$dst/node_modules"
  sed -i '' "s/port: 4173/port: $port/" "$dst/vite.config.ts"
  echo "candidate-$i  $dst  http://localhost:$port"
done
