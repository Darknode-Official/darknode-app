#!/usr/bin/env bash
# Publish the built desktop-app artifacts to the GitHub release the app's
# "Update" tab reads. main.js queries /releases/latest on
# Darknode-Official/darknode-app, so we keep one rolling `latest` release and
# upload the AppImage + .deb for the version in package.json, replacing
# same-named assets. A SHA256SUMS asset is generated and uploaded alongside so
# a user can verify artifact integrity before running it (NX-010).
#
# Usage:
#   GH_TOKEN=ghp_xxx bash scripts/publish-release.sh            # publish current version
#   GH_TOKEN=ghp_xxx bash scripts/publish-release.sh 2.50.0     # publish a specific version
#
# The app updater parses versions out of the asset filenames and picks the
# highest, so keeping one rolling `latest` release is all it needs.
set -euo pipefail

REPO="Darknode-Official/darknode-app"
TAG="latest"
TOKEN="${GH_TOKEN:-${DARKNODE_GH_TOKEN:-${SENTINEL_GH_TOKEN:-}}}"
[ -n "$TOKEN" ] || { echo "error: set GH_TOKEN (or DARKNODE_GH_TOKEN) to a token with repo access to $REPO" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${1:-$(node -p "require('$ROOT/package.json').version")}"
APPIMAGE="$ROOT/dist/Darknode-${VER}.AppImage"
DEB="$ROOT/dist/darknode-app_${VER}_amd64.deb"

api()  { curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }
scrub() { sed "s/${TOKEN}/***/g"; }

# Integrity manifest over whatever artifacts exist, written next to them.
SUMS="$ROOT/dist/SHA256SUMS-${VER}.txt"
gen_sums() {
  local had=0; : > "$SUMS"
  for f in "$APPIMAGE" "$DEB"; do
    [ -f "$f" ] && { (cd "$ROOT/dist" && sha256sum "$(basename "$f")") >> "$SUMS"; had=1; }
  done
  [ "$had" = 1 ] && { echo "  wrote $(basename "$SUMS"):"; sed 's/^/    /' "$SUMS"; } || rm -f "$SUMS"
}

echo "Publishing v${VER} to ${REPO} (tag ${TAG})…"
gen_sums
REL_JSON="$(api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}")"
REL_ID="$(printf '%s' "$REL_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).id || ''")"

if [ -z "$REL_ID" ] || [ "$REL_ID" = "undefined" ]; then
  echo "  release '${TAG}' not found — creating it…"
  REL_JSON="$(api -X POST "https://api.github.com/repos/${REPO}/releases" \
    -d "{\"tag_name\":\"${TAG}\",\"name\":\"Darknode (latest)\",\"body\":\"Rolling release: latest desktop app build. Verify downloads against the SHA256SUMS asset.\"}")"
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
[ -f "$SUMS" ] && upload "$SUMS"
echo "Done. The app's Update tab will now report v${VER} as the latest."
echo "Verify a download:  sha256sum -c SHA256SUMS-${VER}.txt   (after placing it beside the artifact)"
