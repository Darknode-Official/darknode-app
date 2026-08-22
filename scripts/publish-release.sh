#!/usr/bin/env bash
# Publish the built desktop-app artifacts to the GitHub release the app's
# "Update" tab reads (tag `sentinel` on the sentinel-web repo). Uploads the
# AppImage + .deb for the version in package.json, replacing same-named assets.
#
# Usage:
#   GH_TOKEN=ghp_xxx bash scripts/publish-release.sh            # publish current version
#   GH_TOKEN=ghp_xxx bash scripts/publish-release.sh 2.33.0     # publish a specific version
#
# The app updater parses versions out of the asset filenames and picks the
# highest, so keeping one rolling `sentinel` release is all it needs.
set -euo pipefail

REPO="SpartanKing18/sentinel-web"
TAG="sentinel"
TOKEN="${GH_TOKEN:-${SENTINEL_GH_TOKEN:-}}"
[ -n "$TOKEN" ] || { echo "error: set GH_TOKEN (or SENTINEL_GH_TOKEN) to a token with repo access to $REPO" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${1:-$(node -p "require('$ROOT/package.json').version")}"
APPIMAGE="$ROOT/dist/Sentinel-${VER}.AppImage"
DEB="$ROOT/dist/sentinel-app_${VER}_amd64.deb"

api()  { curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }
scrub() { sed "s/${TOKEN}/***/g"; }

echo "Publishing v${VER} to ${REPO} (tag ${TAG})…"
REL_JSON="$(api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}")"
REL_ID="$(printf '%s' "$REL_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id || ''")"

if [ -z "$REL_ID" ] || [ "$REL_ID" = "undefined" ]; then
  echo "  release '${TAG}' not found — creating it…"
  REL_JSON="$(api -X POST "https://api.github.com/repos/${REPO}/releases" \
    -d "{\"tag_name\":\"${TAG}\",\"name\":\"Sentinel (latest)\",\"body\":\"Rolling release: latest desktop app + CLI builds.\"}")"
  REL_ID="$(printf '%s' "$REL_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id || ''")"
fi
[ -n "$REL_ID" ] && [ "$REL_ID" != "undefined" ] || { echo "error: could not resolve release id" >&2; printf '%s\n' "$REL_JSON" | scrub >&2; exit 1; }
echo "  release id: $REL_ID"

upload() {
  local file="$1" name; name="$(basename "$file")"
  [ -f "$file" ] || { echo "  ! missing $file — build it first (npm run dist:linux)"; return 1; }
  # delete an existing same-named asset (the API won't overwrite)
  local old; old="$(printf '%s' "$REL_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const a=(d.assets||[]).find(x=>x.name==='$name');process.stdout.write(a?String(a.id):'')")"
  if [ -n "$old" ]; then echo "  replacing existing $name (asset $old)…"; api -X DELETE "https://api.github.com/repos/${REPO}/releases/assets/${old}" >/dev/null || true; fi
  echo "  uploading $name ($(du -h "$file" | cut -f1))…"
  curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary @"$file" \
    "https://uploads.github.com/repos/${REPO}/releases/${REL_ID}/assets?name=${name}" \
    | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8'));if(r.id){console.log('    ok → '+r.browser_download_url)}else{console.error('    upload failed: '+(r.message||JSON.stringify(r)));process.exit(1)}"
}

upload "$APPIMAGE"
upload "$DEB"
echo "Done. The app's Update tab will now report v${VER} as the latest."
