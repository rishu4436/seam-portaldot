#!/usr/bin/env bash
# SEAM-020: pack the public packages, install the tarballs into an empty directory, run the consumer example and the CLI.
# Proves a clean outside app can use the SDK without repo internals. Offline apart from the npm install of third-party deps.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$ROOT"
npm run build >/dev/null
mkdir "$TMP/tgz"
for p in compiler policy sdk; do npm pack -w "@seam/$p" --pack-destination "$TMP/tgz" >/dev/null; done
APP="$TMP/app"; mkdir "$APP"; cp examples/consumer/index.mjs examples/consumer/package.json "$APP/"
cd "$APP"
node -e '
const fs=require("fs"),d=process.argv[1];const p=JSON.parse(fs.readFileSync("package.json"));
const t=n=>"file:"+d+"/seam-"+n+"-0.1.0.tgz";
p.dependencies={"@seam/sdk":t("sdk"),"@seam/compiler":t("compiler"),"@seam/policy":t("policy")};
p.overrides={"@seam/compiler":t("compiler"),"@seam/policy":t("policy")};
fs.writeFileSync("package.json",JSON.stringify(p,null,2));' "$TMP/tgz"
npm install --no-audit --no-fund --loglevel=error
out="$(node index.mjs)"; echo "$out"
echo "$out" | grep -q "Plan for 1 step"
echo "$out" | grep -q "outcome: partial"
cat "$ROOT/docs/examples/demo-manifest.json" > m.json
./node_modules/.bin/seam digest m.json | grep -q "Manifest is valid"
# no repo path may leak into the installed app
if grep -rq "$ROOT" node_modules/@seam 2>/dev/null; then echo "FAIL: repo path inside installed packages"; exit 1; fi
echo "pack smoke OK"
