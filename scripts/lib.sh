# shellcheck shell=bash
# Fonctions communes aux scripts NIAL CONTROL. Ne pas executer directement.

NIAL_ROOT="${NIAL_ROOT:-/opt/nial-control}"
NIAL_ETC="${NIAL_ETC:-/etc/nial-control}"
NIAL_DATA="${NIAL_DATA:-/var/lib/nial-control}"
NIAL_BACKUPS="${NIAL_BACKUPS:-/var/backups/nial-control}"
NIAL_USER="${NIAL_USER:-nial}"
NIAL_SERVICE="${NIAL_SERVICE:-nial-control}"
NIAL_REPO="${NIAL_REPO:-Flunch4456/Remote-access-for-android}"
NODE_VERSION="${NODE_VERSION:-22.23.4}"
# SKIP_SYSTEMD=1 : pas de systemctl, pas de changement de proprietaire (tests, conteneurs sans systemd)
SKIP_SYSTEMD="${SKIP_SYSTEMD:-0}"

log()  { printf '\033[1;34m[nial]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[nial] ATTENTION :\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[nial] ERREUR :\033[0m %s\n' "$*" >&2; exit 1; }

need_root() { [ "$SKIP_SYSTEMD" = 1 ] || [ "$(id -u)" -eq 0 ] || die "Ce script doit etre lance en root (sudo)."; }
need_cmd()  { command -v "$1" >/dev/null 2>&1 || die "Commande requise introuvable : $1"; }

# Version semantique stricte : evite toute injection dans des chemins ou des URL.
valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; }

node_bin() { echo "$NIAL_ROOT/node/bin/node"; }
current_version() {
  [ -L "$NIAL_ROOT/current" ] || { echo "aucune"; return; }
  basename "$(readlink -f "$NIAL_ROOT/current")"
}

# Sans systemd (SKIP_SYSTEMD=1 : conteneur minimal, tests) : mini-superviseur par fichier PID.
svc() {
  if [ "$SKIP_SYSTEMD" != 1 ]; then systemctl "$@"; return; fi
  local pidf="$NIAL_ROOT/.nial.pid"
  case "$1" in
    stop)
      if [ -f "$pidf" ]; then
        local p; p="$(cat "$pidf")"
        if kill -0 "$p" 2>/dev/null; then kill "$p"; for _ in $(seq 1 30); do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done; fi
        rm -f "$pidf"
      fi ;;
    start)
      [ -f "$NIAL_ETC/nial.env" ] || { warn "pas de configuration : demarrage ignore"; return 1; }
      ( load_env; cd "$NIAL_ROOT/current" && exec "$(node_bin)" --no-warnings dist/index.js >>"$NIAL_BACKUPS/server.log" 2>&1 ) &
      echo $! > "$pidf" ;;
    *) log "(sans systemd) systemctl $*" ;;
  esac
}

chown_nial() { [ "$SKIP_SYSTEMD" = 1 ] || chown -R "$NIAL_USER:$NIAL_USER" "$@"; }

# Charge la configuration du serveur (sans l'exporter plus loin que ce script).
load_env() {
  [ -f "$NIAL_ETC/nial.env" ] || die "Configuration introuvable : $NIAL_ETC/nial.env"
  set -a; # shellcheck disable=SC1091
  . "$NIAL_ETC/nial.env"; set +a
  export DATA_DIR="${DATA_DIR:-$NIAL_DATA}"
}

# Telecharge un fichier de release GitHub en HTTPS strict.
fetch() { curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"; }

sha256_check() {  # sha256_check <fichier> <fichier-SHA256SUMS>
  local f="$1" sums="$2" name expected actual
  name="$(basename "$f")"
  expected="$(awk -v n="$name" '$2==n || $2=="*"n {print $1}' "$sums" | head -n1)"
  [ -n "$expected" ] || die "Somme de controle absente pour $name dans $(basename "$sums")"
  actual="$(sha256sum "$f" | awk '{print $1}')"
  [ "$expected" = "$actual" ] || die "Somme SHA-256 INCORRECTE pour $name (attendu $expected, obtenu $actual). Fichier corrompu ou altere : abandon."
  log "SHA-256 verifiee pour $name"
}

health_wait() {  # health_wait <url> <secondes>
  local url="$1" max="$2" i
  for ((i=1; i<=max; i++)); do
    if curl -fsS --max-time 3 "$url" 2>/dev/null | grep -q '"status":"ok"'; then return 0; fi
    sleep 1
  done
  return 1
}
