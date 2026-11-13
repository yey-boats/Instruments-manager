#!/usr/bin/env bash
# Fail if vendor/proto has drifted from an instruments checkout's proto/.
# Usage: tools/check-vendored-proto.sh <instruments-dir>
# Compares the files the manager actually vendors (JS lib, types, schema,
# fixtures). package.json is intentionally different (no gen scripts/devDeps)
# and proto/js/test is not vendored.
set -euo pipefail
INSTR="${1:?usage: $0 <instruments-dir>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
V="$HERE/vendor/proto"
U="$INSTR/proto"
rc=0
for f in js/index.js js/validators.js js/version.js js/types.d.ts; do
  diff -u "$U/$f" "$V/$f" || rc=1
done
diff -ru "$U/schema" "$V/schema" || rc=1
diff -ru "$U/fixtures" "$V/fixtures" || rc=1
if [ "$rc" -ne 0 ]; then
  echo "vendor/proto is stale vs $INSTR/proto (instruments $(git -C "$INSTR" rev-parse --short HEAD 2>/dev/null || echo '?'))." >&2
  echo "Refresh it (see vendor/proto/README.md) and record the source commit." >&2
  exit 1
fi
echo "vendor/proto matches $INSTR/proto"
