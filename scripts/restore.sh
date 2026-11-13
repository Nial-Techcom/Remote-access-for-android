#!/usr/bin/env bash
# Restaure une sauvegarde faite par backup.sh. ARRETE le service, remplace la base et les secrets.
# Usage : restore.sh <fichier-sauvegarde> [--yes]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
umask 077
need_root; need_cmd tar; need_cmd sha256sum
FILE="${1:-}"; [ -f "$FILE" ] || die "Usage : restore.sh <fichier-sauvegarde> [--yes]"
if [ "${2:-}" != "--yes" ]; then
  read -r -p "Cette operation REMPLACE la base et les cles actuelles. Continuer ? [oui/N] " a
  [ "$a" = "oui" ] || die "Abandon."
fi
if [ -f "$FILE.sha256" ]; then ( cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" >/dev/null ) || die "Somme de controle de la sauvegarde incorrecte"; log "Somme de controle de la sauvegarde verifiee"
else warn "Pas de fichier .sha256 a cote de la sauvegarde : integrite non verifiee"; fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
SRC="$FILE"
if [[ "$FILE" == *.gpg ]]; then
  need_cmd gpg; [ -n "${BACKUP_PASSPHRASE_FILE:-}" ] || die "Sauvegarde chiffree : definir BACKUP_PASSPHRASE_FILE"
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" -o "$WORK/b.tar.gz" -d "$FILE"
  SRC="$WORK/b.tar.gz"
fi
mkdir -p "$WORK/x"; tar -C "$WORK/x" -xzf "$SRC"
[ -f "$WORK/x/data/nial.db" ] || die "Sauvegarde invalide : nial.db absent"
# Controle d'integrite SQLite avant de toucher a la production
NODE="$(node_bin)"; [ -x "$NODE" ] || NODE="$(command -v node)"
"$NODE" --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare('PRAGMA integrity_check').get();process.exit(r.integrity_check==='ok'?0:1)" "$WORK/x/data/nial.db" || die "La base de la sauvegarde est corrompue"

DATA_DIR_="${DATA_DIR:-$NIAL_DATA}"
svc stop "$NIAL_SERVICE" || true
mkdir -p "$NIAL_BACKUPS"; chmod 700 "$NIAL_BACKUPS"
if [ -f "$DATA_DIR_/nial.db" ]; then cp -p "$DATA_DIR_/nial.db" "$NIAL_BACKUPS/avant-restauration-$(date -u +%Y%m%dT%H%M%SZ).db"; fi
rm -f "$DATA_DIR_"/nial.db-wal "$DATA_DIR_"/nial.db-shm
install -m 600 "$WORK/x/data/nial.db" "$DATA_DIR_/nial.db"
for f in server-signing.key stream-secrets; do [ -f "$WORK/x/data/$f" ] && install -m 600 "$WORK/x/data/$f" "$DATA_DIR_/$f"; done
chown_nial "$DATA_DIR_"
svc start "$NIAL_SERVICE"
# Les fichiers de /etc ne sont jamais ecrases automatiquement : on les depose a cote pour comparaison manuelle.
ETC_OUT="$NIAL_BACKUPS/etc-restaure-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ETC_OUT"; chmod 700 "$ETC_OUT"; cp -p "$WORK"/x/etc/* "$ETC_OUT"/ 2>/dev/null || true
log "Restauration terminee (version sauvegardee : $(cat "$WORK/x/VERSION" 2>/dev/null || echo inconnue))."
log "Configuration sauvegardee (non appliquee) : $ETC_OUT"
