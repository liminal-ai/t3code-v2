#!/usr/bin/env bash
# lhc/stage-sidecar.sh <dir> [tarball]
# Stages the claude-lhc that lhc/sidecar.json pins into <dir> and prints its entry, the value for
# CLAUDE_LHC_SIDECAR. Without [tarball] it packs the pinned version from the npm registry. It refuses
# a tarball whose sha512 is not the pinned integrity.
set -euo pipefail
dir=${1:?usage: lhc/stage-sidecar.sh <dir> [tarball]}
tarball=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -z "$tarball" ]; then
  spec=$(node -p 'const p = require(process.argv[1]); `${p.package}@${p.version}`' "$here/sidecar.json")
  (cd "$work" && npm pack "$spec" >/dev/null)
  tarball=$(echo "$work"/*.tgz)
fi
node - "$here/sidecar.json" "$here/sidecar/package-lock.json" "$tarball" <<'JS'
const fs = require("node:fs");
const crypto = require("node:crypto");
const [pinFile, lockFile, tarball] = process.argv.slice(2);
const pin = JSON.parse(fs.readFileSync(pinFile, "utf8"));
const locked = JSON.parse(fs.readFileSync(lockFile, "utf8")).packages[`node_modules/${pin.package}`];
if (locked?.version !== pin.version || locked?.integrity !== pin.integrity) {
  console.error(`lhc/sidecar/package-lock.json locks ${pin.package}@${locked?.version} ${locked?.integrity}, but lhc/sidecar.json pins ${pin.version} ${pin.integrity}`);
  process.exit(1);
}
const actual = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
if (actual !== pin.integrity) {
  console.error(`refusing ${tarball}: its integrity is ${actual}, but lhc/sidecar.json pins ${pin.integrity}`);
  process.exit(1);
}
JS

mkdir -p "$dir"
cp "$here/sidecar/package.json" "$here/sidecar/package-lock.json" "$dir/"
cp "$tarball" "$dir/claude-lhc.tgz"
npm ci --prefix "$dir" --omit=dev --omit=optional --ignore-scripts --no-fund --no-audit >&2
find "$dir/node_modules" -type f \( -name '*.map' -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' \) -delete
find "$dir/node_modules" -name .bin -prune -exec rm -rf {} +
entry=$dir/node_modules/claude-lhc/dist/sidecar.js
[ -f "$entry" ] || { echo "staged no $entry" >&2; exit 1; }
echo "$entry"
