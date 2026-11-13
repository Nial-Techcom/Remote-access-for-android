#!/usr/bin/env bash
# Mise a jour de NIAL CONTROL avec sauvegarde prealable, verification d'integrite et retour arriere automatique.
#
# Usage :
#   update.sh --check                      affiche la version installee et la derniere release disponible
#   update.sh [--version X.Y.Z]            met a jour (defaut : derniere release stable)
#   update.sh --tarball F --sums S         met a jour depuis des fichiers locaux (hors ligne, tests)
#   update.sh --rollback                   revient a la version precedente (voir UPDATE.md pour la base de donnees)
#   update.sh --yes                        pas de confirmation interactive
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
umask 027

MODE=update; VERSION=""; TARBALL=""; SUMS=""; ASSUME_YES=0; ALLOW_PRE=0; NO_START=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --rollback) MODE=rollback ;;
    --version) VERSION="${2:-}"; shift ;;
    --tarball) TARBALL="${2:-}"; shift ;;
    --sums) SUMS="${2:-}"; shift ;;
    --yes|-y) ASSUME_YES=1 ;;
    --allow-prerelease) ALLOW_PRE=1 ;;
    --no-start) NO_START=1 ;;  # premiere installation : la configuration n'existe pas encore
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "Option inconnue : $1" ;;
  esac; shift
done

need_root; need_cmd curl; need_cmd tar; need_cmd sha256sum
mkdir -p "$NIAL_ROOT/releases" "$NIAL_BACKUPS"
LOGFILE="${NIAL_LOG:-/var/log/nial-control-update.log}"
[ "$SKIP_SYSTEMD" = 1 ] && LOGFILE="$NIAL_BACKUPS/update.log"
exec > >(tee -a "$LOGFILE") 2>&1
log "=== $(date -u +%FT%TZ) update.sh $MODE ==="

# Un seul update a la fois
exec 9>"$NIAL_ROOT/.update.lock"; flock -n 9 || die "Une mise a jour est deja en cours."

CUR="$(current_version)"
HEALTH_URL="http://${HOST:-127.0.0.1}:${PORT:-8080}/api/health"
if [ -f "$NIAL_ETC/nial.env" ]; then
  H="$(grep -E '^HOST=' "$NIAL_ETC/nial.env" | tail -1 | cut -d= -f2- || true)"; P="$(grep -E '^PORT=' "$NIAL_ETC/nial.env" | tail -1 | cut -d= -f2- || true)"
  HEALTH_URL="http://${H:-127.0.0.1}:${P:-8080}/api/health"
fi

latest_release() {
  local json tag
  if [ "$ALLOW_PRE" = 1 ]; then json="$(curl --proto '=https' --tlsv1.2 -fsSL "https://api.github.com/repos/$NIAL_REPO/releases?per_page=1")"; tag="$(printf '%s' "$json" | grep -m1 '"tag_name"' | cut -d'"' -f4)"
  else json="$(curl --proto '=https' --tlsv1.2 -fsSL "https://api.github.com/repos/$NIAL_REPO/releases/latest")"; tag="$(printf '%s' "$json" | grep -m1 '"tag_name"' | cut -d'"' -f4)"; fi
  printf '%s' "${tag#v}"
}

switch_to() {  # switch_to <version> : bascule atomique du lien symbolique
  local v="$1"
  ln -sfn "$NIAL_ROOT/releases/$v" "$NIAL_ROOT/current.new"
  mv -Tf "$NIAL_ROOT/current.new" "$NIAL_ROOT/current"
}

# ------------------------------------------------------------------ check
if [ "$MODE" = check ]; then
  log "Version installee : $CUR"
  LATEST="$(latest_release)"; valid_version "$LATEST" || die "Reponse inattendue de GitHub"
  log "Derniere release  : $LATEST"
  [ "$CUR" = "$LATEST" ] && log "Vous etes a jour." || log "Mise a jour disponible : lancez update.sh"
  exit 0
fi

# --------------------------------------------------------------- rollback
if [ "$MODE" = rollback ]; then
  [ -f "$NIAL_ROOT/previous" ] || die "Aucune version precedente enregistree."
  PREV="$(cat "$NIAL_ROOT/previous")"; valid_version "$PREV" || die "Fichier 'previous' invalide"
  [ -d "$NIAL_ROOT/releases/$PREV" ] || die "La version $PREV n'est plus presente dans $NIAL_ROOT/releases"
  BK="$(cat "$NIAL_ROOT/previous.backup" 2>/dev/null || true)"
  log "Retour de $CUR vers $PREV"
  if [ "$ASSUME_YES" != 1 ]; then read -r -p "Confirmer le retour arriere ? [oui/N] " a; [ "$a" = oui ] || die "Abandon."; fi
  svc stop "$NIAL_SERVICE" || true
  if [ -n "$BK" ] && [ -f "$BK" ]; then
    log "Restauration de la base d'avant mise a jour : $BK"
    load_env; DD="${DATA_DIR:-$NIAL_DATA}"
    cp -p "$DD/nial.db" "$NIAL_BACKUPS/avant-rollback-$(date -u +%Y%m%dT%H%M%SZ).db" 2>/dev/null || true
    rm -f "$DD"/nial.db-wal "$DD"/nial.db-shm; install -m 600 "$BK" "$DD/nial.db"; chown_nial "$DD"
    warn "Les donnees creees depuis la mise a jour (commandes, journaux, sessions) sont perdues ; copie conservee dans $NIAL_BACKUPS."
  else warn "Pas de sauvegarde de base associee : la base actuelle est conservee telle quelle."; fi
  switch_to "$PREV"; echo "$CUR" > "$NIAL_ROOT/previous"; rm -f "$NIAL_ROOT/previous.backup"
  svc start "$NIAL_SERVICE"
  if health_wait "$HEALTH_URL" 40; then log "Retour arriere reussi : version $PREV en service."; else die "Le service ne repond pas apres le retour arriere. Consultez : journalctl -u $NIAL_SERVICE -n 100"; fi
  exit 0
fi

# ----------------------------------------------------------------- update
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] && [ -f "$SUMS" ] || die "--tarball et --sums doivent designer des fichiers existants"
  name="$(basename "$TARBALL")"; [[ "$name" =~ ^nial-control-server-([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?)\.tar\.gz$ ]] || die "Nom d'archive inattendu : $name"
  VERSION="${BASH_REMATCH[1]}"; cp "$TARBALL" "$WORK/$name"; cp "$SUMS" "$WORK/SHA256SUMS"
else
  [ -n "$VERSION" ] || VERSION="$(latest_release)"; VERSION="${VERSION#v}"
  valid_version "$VERSION" || die "Version invalide : '$VERSION'"
  name="nial-control-server-$VERSION.tar.gz"; base="https://github.com/$NIAL_REPO/releases/download/v$VERSION"
  log "Telechargement de la release v$VERSION"
  fetch "$base/$name" "$WORK/$name"; fetch "$base/SHA256SUMS" "$WORK/SHA256SUMS"
fi
[ "$VERSION" != "$CUR" ] || die "La version $VERSION est deja installee."
if [ "${#VERSION}" -gt 0 ] && [ "$CUR" != aucune ]; then
  # refuse les retours en arriere deguises en mise a jour (utiliser --rollback)
  lowest="$(printf '%s\n%s\n' "${CUR%%-*}" "${VERSION%%-*}" | sort -V | head -n1)"
  [ "$lowest" = "${CUR%%-*}" ] || warn "La version $VERSION est plus ANCIENNE que $CUR. Preferez --rollback (qui restaure aussi la base)."
fi
sha256_check "$WORK/$name" "$WORK/SHA256SUMS"
# Le chemin de l'archive ne doit contenir ni chemin absolu ni '..' (tar malveillant)
if tar -tzf "$WORK/$name" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then die "Archive refusee : chemins dangereux"; fi

log "Mise a jour : $CUR -> $VERSION"
if [ "$ASSUME_YES" != 1 ]; then read -r -p "Continuer ? [oui/N] " a; [ "$a" = oui ] || die "Abandon."; fi

# Espace disque (au moins 300 Mo libres)
avail="$(df -Pm "$NIAL_ROOT" | awk 'NR==2{print $4}')"; [ "${avail:-0}" -ge 300 ] || die "Espace disque insuffisant (${avail:-?} Mo libres, 300 requis)"

# 1. sauvegarde prealable
PREBK="$NIAL_BACKUPS/pre-update-${CUR}-to-${VERSION}.db"
if [ "$CUR" != aucune ]; then
  load_env
  log "Sauvegarde de la base avant mise a jour"
  "$(node_bin)" "$NIAL_ROOT/current/dist/cli.js" backup "$PREBK" >/dev/null 2>&1 || die "Sauvegarde prealable impossible : mise a jour annulee, rien n'a ete modifie."
  BACKUP_OUT="$("$HERE/backup.sh" 2>/dev/null | tail -n1 || true)"; [ -n "$BACKUP_OUT" ] && log "Sauvegarde complete : $BACKUP_OUT"
fi

# 2. installation dans un dossier neuf (la version courante n'est pas touchee)
DEST="$NIAL_ROOT/releases/$VERSION"; [ ! -e "$DEST" ] || rm -rf "$DEST"
mkdir -p "$DEST"; tar -C "$DEST" -xzf "$WORK/$name" --no-same-owner
[ -f "$DEST/dist/index.js" ] && [ -f "$DEST/package-lock.json" ] || { rm -rf "$DEST"; die "Archive incomplete"; }
log "Installation des dependances (sans scripts d'installation)"
( cd "$DEST" && PATH="$NIAL_ROOT/node/bin:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error ) || { rm -rf "$DEST"; die "npm ci a echoue : mise a jour annulee"; }
chown_nial "$DEST"

# 3. bascule + redemarrage + controle de sante, avec retour arriere automatique
rollback_auto() {
  warn "Echec : retour automatique a la version $CUR"
  svc stop "$NIAL_SERVICE" || true
  if [ "$CUR" != aucune ]; then
    if [ -f "$PREBK" ]; then load_env; DD="${DATA_DIR:-$NIAL_DATA}"; rm -f "$DD"/nial.db-wal "$DD"/nial.db-shm; install -m 600 "$PREBK" "$DD/nial.db"; chown_nial "$DD"; log "Base restauree depuis $PREBK"; fi
    switch_to "$CUR"; svc start "$NIAL_SERVICE" || true
    health_wait "$HEALTH_URL" 40 && log "Version $CUR de nouveau en service." || warn "Le service ne repond pas : journalctl -u $NIAL_SERVICE -n 100"
  fi
  rm -rf "$DEST"
  die "Mise a jour vers $VERSION annulee."
}
if [ "$NO_START" = 1 ]; then
  switch_to "$VERSION"
  log "Version $VERSION installee (service non demarre : --no-start)."
  exit 0
fi
svc stop "$NIAL_SERVICE" || true
switch_to "$VERSION"
svc start "$NIAL_SERVICE" || rollback_auto
if ! health_wait "$HEALTH_URL" 45; then rollback_auto; fi

# 4. enregistrement pour --rollback et menage (on garde les 3 dernieres versions)
if [ "$CUR" != aucune ]; then echo "$CUR" > "$NIAL_ROOT/previous"; echo "$PREBK" > "$NIAL_ROOT/previous.backup"; fi
ls -1dt "$NIAL_ROOT"/releases/*/ 2>/dev/null | tail -n +4 | while read -r old; do [ "$(basename "$old")" = "$VERSION" ] || [ "$(basename "$old")" = "$CUR" ] || rm -rf "$old"; done
log "Mise a jour reussie : version $VERSION en service (precedente : $CUR)."
