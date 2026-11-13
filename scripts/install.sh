#!/usr/bin/env bash
# Installation de NIAL CONTROL dans un LXC/VM Debian 12+ ou Ubuntu 22.04+.
# Usage : install.sh [--version X.Y.Z] [--tarball F --sums S]
# Ce script : cree l'utilisateur systeme, installe Node.js (verifie par SHA-256), installe le serveur,
# genere la configuration, installe le service systemd durci, et NE l'expose PAS a Internet.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
umask 027
VERSION=""; TARBALL=""; SUMS=""
while [ $# -gt 0 ]; do
  case "$1" in --version) VERSION="${2:-}"; shift ;; --tarball) TARBALL="${2:-}"; shift ;; --sums) SUMS="${2:-}"; shift ;; -h|--help) sed -n '2,6p' "$0"; exit 0 ;; *) die "Option inconnue : $1" ;; esac; shift
done
need_root; need_cmd curl; need_cmd tar; need_cmd sha256sum
[ ! -L "$NIAL_ROOT/current" ] || die "NIAL CONTROL est deja installe ($(current_version)). Utilisez update.sh."

# --- utilisateur systeme et dossiers ---
if [ "$SKIP_SYSTEMD" != 1 ]; then
  id "$NIAL_USER" >/dev/null 2>&1 || useradd --system --home-dir "$NIAL_DATA" --shell /usr/sbin/nologin "$NIAL_USER"
fi
mkdir -p "$NIAL_ROOT/releases" "$NIAL_ETC" "$NIAL_DATA" "$NIAL_BACKUPS"
chmod 750 "$NIAL_ETC"; chmod 700 "$NIAL_DATA" "$NIAL_BACKUPS"
[ "$SKIP_SYSTEMD" = 1 ] || chown root:"$NIAL_USER" "$NIAL_ETC"
chown_nial "$NIAL_DATA"

# --- Node.js : archive officielle, somme SHA-256 verifiee contre SHASUMS256.txt ---
if [ ! -x "$(node_bin)" ]; then
  case "$(uname -m)" in x86_64) A=x64 ;; aarch64|arm64) A=arm64 ;; *) die "Architecture non geree : $(uname -m)" ;; esac
  T="node-v$NODE_VERSION-linux-$A.tar.xz"; W="$(mktemp -d)"
  log "Telechargement de Node.js $NODE_VERSION ($A)"
  fetch "https://nodejs.org/dist/v$NODE_VERSION/$T" "$W/$T"; fetch "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$W/SHASUMS256.txt"
  sha256_check "$W/$T" "$W/SHASUMS256.txt"
  mkdir -p "$NIAL_ROOT/node"; tar -C "$NIAL_ROOT/node" -xJf "$W/$T" --strip-components=1; rm -rf "$W"
fi
log "Node.js : $("$(node_bin)" -v)"

# --- serveur ---
UARGS=(--yes --no-start); [ -n "$VERSION" ] && UARGS+=(--version "$VERSION"); [ -n "$TARBALL" ] && UARGS+=(--tarball "$TARBALL" --sums "$SUMS")
# Premiere installation : update.sh installe sans demarrer (la configuration n'existe pas encore)
"$HERE/update.sh" "${UARGS[@]}"

# --- configuration (jamais ecrasee) ---
if [ ! -f "$NIAL_ETC/nial.env" ]; then
  install -m 640 "$NIAL_ROOT/current/deploy/nial.env.example" "$NIAL_ETC/nial.env"
  sed -i -e "s#^DATA_DIR=.*#DATA_DIR=$NIAL_DATA#" -e "s#^NAVIDROME_PASSWORD_FILE=.*#NAVIDROME_PASSWORD_FILE=$NIAL_ETC/navidrome.pass#" "$NIAL_ETC/nial.env"
  [ "$SKIP_SYSTEMD" = 1 ] || chown root:"$NIAL_USER" "$NIAL_ETC/nial.env"
  warn "Editez $NIAL_ETC/nial.env (PUBLIC_URL, NAVIDROME_URL, NAVIDROME_USER) puis creez $NIAL_ETC/navidrome.pass."
fi
[ -f "$NIAL_ETC/navidrome.pass" ] || { : > "$NIAL_ETC/navidrome.pass"; chmod 640 "$NIAL_ETC/navidrome.pass"; [ "$SKIP_SYSTEMD" = 1 ] || chown root:"$NIAL_USER" "$NIAL_ETC/navidrome.pass"; }

# --- service systemd ---
if [ "$SKIP_SYSTEMD" != 1 ]; then
  install -m 644 "$NIAL_ROOT/current/deploy/systemd/nial-control.service" /etc/systemd/system/nial-control.service
  install -m 644 "$NIAL_ROOT/current/deploy/systemd/nial-backup.service" /etc/systemd/system/nial-backup.service
  install -m 644 "$NIAL_ROOT/current/deploy/systemd/nial-backup.timer" /etc/systemd/system/nial-backup.timer
  systemctl daemon-reload; systemctl enable nial-control.service nial-backup.timer >/dev/null
fi
cat <<MSG

Installation terminee (version $(current_version)).
Etapes suivantes :
  1. Editer  $NIAL_ETC/nial.env  et ecrire le mot de passe du compte Navidrome DEDIE (non admin) dans $NIAL_ETC/navidrome.pass
  2. Creer le premier administrateur :
       sudo -u $NIAL_USER env DATA_DIR=$NIAL_DATA $NIAL_ROOT/node/bin/node $NIAL_ROOT/current/dist/cli.js create-admin <identifiant>
  3. Demarrer :  systemctl start nial-control && curl -s http://127.0.0.1:8080/api/health
  4. Mettre un reverse proxy TLS devant (deploy/caddy/Caddyfile). Ne PAS exposer le port 8080 directement.
MSG
