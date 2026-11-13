#!/usr/bin/env bash
# Build runsc with Tesseract time skipping.
#
# Clones gVisor's `go` branch (the go-buildable mirror of the Bazel tree) at a
# pinned commit, applies tesseract-time-skip.patch, and builds runsc plus the
# sidecar binaries it needs. The few sidecars that are not Go packages on the
# `go` branch are taken from the matching gVisor release tarball.
#
# Output: $OUT/runsc and $OUT/gvisor-bin/*   (default OUT=./out)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-$HERE/out}
WORK=${WORK:-$HERE/.work}
GVISOR_COMMIT=1ac1e607b563c65b0e430c93213e9b58e52bc764   # go branch, 2026-11-12
RELEASE=20261109                                          # for non-Go sidecars

mkdir -p "$WORK" "$OUT/gvisor-bin"
if [ ! -d "$WORK/gvisor" ]; then
  git clone --branch go https://github.com/google/gvisor.git "$WORK/gvisor"
fi
cd "$WORK/gvisor"
git fetch --depth 1 origin "$GVISOR_COMMIT" 2>/dev/null || true
git checkout -q -f "$GVISOR_COMMIT"
git clean -qfd
git apply "$HERE/tesseract-time-skip.patch"

export CGO_ENABLED=0 GOTOOLCHAIN=auto   # the sentry must be static: it re-execs itself inside a chroot
go build -o "$OUT/runsc" ./runsc
go build -o "$OUT/gvisor-bin/gvisor_sentry" ./runsc/cmd/sentry
go build -o "$OUT/gvisor-bin/checkpointgofer" ./runsc/checkpointgofer
go build -o "$OUT/gvisor-bin/runsc-netgofer" ./runsc/cmd/netgofer
go build -o "$OUT/tesscoord" ./tools/tesscoord

if [ ! -f "$OUT/gvisor-bin/gvisor-sentry-prewarmer" ]; then
  url=https://storage.googleapis.com/gvisor/releases/release/$RELEASE/$(uname -m)
  curl -fsSL "$url/gvisor.tar.bz2" -o "$WORK/gvisor.tar.bz2"
  curl -fsSL "$url/gvisor.tar.bz2.sha512" -o "$WORK/gvisor.tar.bz2.sha512"
  (cd "$WORK" && sha512sum -c gvisor.tar.bz2.sha512)
  tar -xjf "$WORK/gvisor.tar.bz2" -C "$WORK"
  for f in gvisor-sentry-prewarmer runsc-fd-parking gvisor-proc-umounter runsc-metric-server; do
    cp "$WORK/gvisor-bin/$f" "$OUT/gvisor-bin/"
  done
fi
echo "built $OUT/runsc"
