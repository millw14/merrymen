# Lighter signer (vendored)

The only code in merrymen that can produce a Lighter transaction. Loaded by
`worker/src/perps/signer.ts`, which hashes both files before running a byte of
either, runs them in an isolated `node:vm` context, and refuses to arm unless a
known-answer test against live mainnet transactions passes. Contract:
`docs/perps.md` ("signer.ts").

| file | what | source | sha256 |
|---|---|---|---|
| `lighter-signer.wasm` | lighter-go **v1.0.9** Node/Go-js signer build, 13,964,645 bytes | <https://github.com/elliottech/lighter-go/releases/download/v1.0.9/lighter-signer.wasm> | `781ba28b5e7fca1ea816f516f28fe2adbe704b734828e0c941025f8133bd7b4b` |
| `wasm_exec.js` | Go's JS runtime shim from the **go1.25.6** release that built it | <https://raw.githubusercontent.com/golang/go/go1.25.6/lib/wasm/wasm_exec.js> | `0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14` |

Both hashes are pinned in `LIGHTER_SIGNER_ARTIFACT` (signer.ts) and in
`signer.test.ts`. A mismatch is `SignerUnavailable("hash-mismatch")`: live perps
stay unarmed; paper perps never load this at all.

## Why this build

- **v1.0.9 is the last release with the Node-style build.** v1.0.10 ships only
  `lighter-signer-web.wasm` (promise-style, a different export surface), and its
  release asset does not even match the `web-wasm/main.wasm` committed at that
  tag. `wasm/main.go` and the tx types are otherwise unchanged v1.0.9 → v1.0.10
  apart from the cancel-all market-index maximum (255 → MaxMarketIndex), which
  does not matter for market ids 0–56.
- **The release asset is built outside CI** (the embedded build info says
  go1.25.6; the repo's CI builds with go.mod's 1.23). So we do not trust the
  asset because of where it came from: we rebuilt it from source and got the
  same bytes (below).
- **`wasm_exec.js` must come from the Go release that built the wasm.** go1.23's
  happens to work too; it is not what built this, so it is not what we ship.

Embedded build info of the asset: `go1.25.6`,
`vcs.revision=8854554703385766c73410b43e93075447f36a4c`, `vcs.modified=false`,
module version `v1.0.9-0.20260911113058-885455470338`.

## Reproduce from source

Byte-for-byte, verified 2026-09-29 on darwin-arm64 (a `GOOS=js GOARCH=wasm`
cross-build with `-trimpath` should not depend on the host; only darwin-arm64
has been checked):

```sh
# go1.25.6 from https://go.dev/dl/ (verify its sha256 against go.dev/dl first)
git clone https://github.com/elliottech/lighter-go && cd lighter-go
git checkout 8854554703385766c73410b43e93075447f36a4c
# The asset's embedded pseudo-version (v1.0.9-0.20260911113058-885455470338)
# says it was built from a checkout WITHOUT the v1.0.9/v1.0.10 tags; the
# byte-identical rebuild was made that way. With a tag present Go stamps a
# different module version into the build info.
git tag -d v1.0.9 v1.0.10 2>/dev/null || true
go mod vendor
GOOS=js GOARCH=wasm go build -trimpath -o lighter-signer.wasm ./wasm/
shasum -a 256 lighter-signer.wasm
# 781ba28b5e7fca1ea816f516f28fe2adbe704b734828e0c941025f8133bd7b4b

curl -fsSL https://raw.githubusercontent.com/golang/go/go1.25.6/lib/wasm/wasm_exec.js | shasum -a 256
# 0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14
```

## Upgrading

A signer upgrade is a change to the one component that can move money on
Lighter. It is never a drive-by dependency bump.

1. Pick a lighter-go release that still ships a Node/Go-js build (or add a
   loader for the web build — a separate, reviewed change). Read the diff of
   `wasm/main.go`, `types/txtypes/*` and `client/*` since 8854554: new exports,
   changed argument order, changed defaults (chain id, `DefaultExpireTime`,
   nonce handling) all break assumptions signer.ts relies on.
2. Rebuild from source with the Go version the release names, as above, and
   require the release asset's hash to equal yours. Fetch that Go version's
   `wasm_exec.js`.
3. Replace both files here, and update the hashes, size and commit in this
   README, `LIGHTER_SIGNER_ARTIFACT` and `signer.test.ts`.
4. Run `npx tsx --test worker/src/perps/signer.test.ts`. The known-answer test
   re-signs live Robinhood-instance txs (`SIGNER_KNOWN_ANSWERS`, fixtures
   `tx.*.json`) with a frozen clock and must reproduce their hashes, ExpiredAt
   and every field; the output-binding tests must still catch tampering; the
   sandbox test must still find nothing on the worker's global. Add a fresh live
   vector if the tx types changed.
5. Re-run the Phase-0 mainnet checklist items that exercise signing
   (`docs/perps.md`, Rollout) before the new signer arms anyone's live perps.

## Packaging

`package.json` `files` ships `worker/` (so this directory), `.npmignore` does not
exclude `*.wasm`, and the hosted `Dockerfile` copies the whole tree
(`COPY . .`; `.dockerignore` does not exclude it). The wasm is ~14 MB raw,
~4 MB gzipped, in the npm tarball.
