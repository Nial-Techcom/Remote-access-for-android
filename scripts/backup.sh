#!/usr/bin/env bash
# Sauvegarde NIAL CONTROL : base SQLite (copie coherente), cle de signature, secrets de flux, configuration.
# Usage : backup.sh [dossier-destination]
# Chiffrement : definir BACKUP_PASSPHRASE_FILE (fichier lisible par root seul) pour chiffrer avec gpg (AES-256).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
umask 077
need_root; need_cmd tar; need_cmd sha256sum
load_env

DEST="${1:-$NIAL_BACKUPS}"
mkdir -p "$DEST"; chmod 700 "$DEST"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/etc"

NODE="$(node_bin)"; [ -x "$NODE" ] || NODE="$(command -v node)"
"$NODE" "$NIAL_ROOT/current/dist/cli.js" backup "$WORK/data/nial.db" >/dev/null 2>&1 || die "Sauvegarde de la base impossible"
for f in server-signing.key stream-secrets; do
  [ -f "$DATA_DIR/$f" ] && cp -p "$DATA_DIR/$f" "$WORK/data/$f"
done
cp -p "$NIAL_ETC"/* "$WORK/etc/" 2>/dev/null || true
echo "version=$(current_version)" > "$WORK/VERSION"

OUT="$DEST/nial-backup-$TS.tar.gz"
tar -C "$WORK" -czf "$OUT" .
if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  need_cmd gpg
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" --symmetric --cipher-algo AES256 -o "$OUT.gpg" "$OUT"
  shred -u "$OUT" 2>/dev/null || rm -f "$OUT"
  OUT="$OUT.gpg"
fi
chmod 600 "$OUT"
( cd "$DEST" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )
# Retention : on garde les N dernieres sauvegardes (defaut 14)
KEEP="${BACKUP_KEEP:-14}"
find "$DEST" -maxdepth 1 -type f \( -name 'nial-backup-*.tar.gz' -o -name 'nial-backup-*.tar.gz.gpg' \) -printf '%T@ %p\n' | sort -rn | tail -n +"$((KEEP+1))" | cut -d' ' -f2- | while read -r old; do rm -f "$old" "$old.sha256"; done
log "Sauvegarde ecrite : $OUT"
echo "$OUT"
