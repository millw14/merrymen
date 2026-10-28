#!/usr/bin/env bash
# Downloads one file and keeps it only if its size and SHA-256 match the pins.
#
#   fetch-verified.sh <https-url> <bytes> <sha256> <out>
#
# The download lands at <out>.part and is renamed to <out> only after both
# checks pass, so a partial, replaced or tampered file is never left where a
# later step would unpack it. HTTPS only, redirects included.
set -euo pipefail

[ $# -eq 4 ] || { echo "usage: fetch-verified.sh <https-url> <bytes> <sha256> <out>" >&2; exit 2; }
url=$1 bytes=$2 sha=$3 out=$4

case $url in https://*) ;; *) echo "::error::refusing a non-HTTPS URL: $url" >&2; exit 2 ;; esac
[[ $bytes =~ ^[1-9][0-9]*$ ]] || { echo "::error::size pin is not a byte count: $bytes" >&2; exit 2; }
[[ $sha =~ ^[0-9a-f]{64}$ ]] || { echo "::error::SHA-256 pin is not 64 lowercase hex digits: $sha" >&2; exit 2; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

part="$out.part"
rm -f -- "$out" "$part"
trap 'rm -f -- "$part"' EXIT
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  --retry 3 --retry-all-errors --output "$part" "$url"

got_bytes=$(wc -c < "$part" | tr -d ' ')
got_sha=$(sha256_of "$part")
if [ "$got_bytes" != "$bytes" ] || [ "$got_sha" != "$sha" ]; then
  echo "::error::$url does not match its pin: got $got_bytes bytes with SHA-256 $got_sha, want $bytes bytes with SHA-256 $sha" >&2
  exit 1
fi
mv -- "$part" "$out"
echo "verified $url ($bytes bytes, SHA-256 $sha)"
