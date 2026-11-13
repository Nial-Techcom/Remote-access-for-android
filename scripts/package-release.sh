#!/usr/bin/env bash
# Construit l'archive serveur d'une release : nial-control-server-<version>.tar.gz + SHA256SUMS.
# Usage : package-release.sh [dossier-sortie]   (la version est lue dans server/package.json)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/release-out}"
VERSION="$(node -p "require('$ROOT/server/package.json').version")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "Version invalide : $VERSION" >&2; exit 1; }
mkdir -p "$OUT"; STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
( cd "$ROOT/server" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent )
mkdir -p "$STAGE"
cp -r "$ROOT/server/dist" "$STAGE/dist"
cp "$ROOT/server/package.json" "$ROOT/server/package-lock.json" "$STAGE/"
cp -r "$ROOT/scripts" "$STAGE/scripts"; cp "$ROOT/CHANGELOG.md" "$STAGE/" 2>/dev/null || true
cp -r "$ROOT/deploy" "$STAGE/deploy"
rm -rf "$STAGE"/dist/*.map 2>/dev/null || true
# Archive reproductible : ordre, dates et proprietaires normalises
( cd "$STAGE" && tar --sort=name --mtime='2020-01-01 00:00:00Z' --owner=0 --group=0 --numeric-owner -czf "$OUT/nial-control-server-$VERSION.tar.gz" . )
( cd "$OUT" && sha256sum "nial-control-server-$VERSION.tar.gz" > SHA256SUMS )
echo "$OUT/nial-control-server-$VERSION.tar.gz"
