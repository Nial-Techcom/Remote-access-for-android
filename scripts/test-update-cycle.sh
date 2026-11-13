#!/usr/bin/env bash
# Test de bout en bout de l'installation, des mises a jour et des retours arriere, dans un dossier temporaire,
# sans systemd (SKIP_SYSTEMD=1). Necessite node, npm, curl. Usage : scripts/test-update-cycle.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; export SKIP_SYSTEMD=1
export NIAL_ROOT="$T/opt" NIAL_ETC="$T/etc" NIAL_DATA="$T/data" NIAL_BACKUPS="$T/bk" NIAL_LOG="$T/update.log"
PORT=$((20000 + RANDOM % 10000))
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \033[32mOK\033[0m   %s\n' "$1"; }
ko()   { fail=$((fail+1)); printf '  \033[31mECHEC\033[0m %s\n' "$1"; }
check(){ if eval "$2"; then ok "$1"; else ko "$1"; fi; }
cleanup(){ [ -f "$NIAL_ROOT/.nial.pid" ] && kill "$(cat "$NIAL_ROOT/.nial.pid")" 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
NODE="$(command -v node)"
# shellcheck source=lib.sh
. "$REPO/scripts/lib.sh"

build() { # build <version> [mauvais]
  local v="$1"; local src="$T/src/$v"; mkdir -p "$src"
  ( cd "$REPO" && tar --exclude=node_modules --exclude=.git --exclude=release-out --exclude=dist -cf - . ) | tar -C "$src" -xf -
  ( cd "$src/server" && npm version "$v" --no-git-tag-version --allow-same-version >/dev/null )
  if [ "${2:-}" = mauvais ]; then
    # Version defectueuse : ecrit dans la base puis plante, pour verifier que la base est restauree.
    ( cd "$src/server" && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run build --silent )
    cat > "$src/server/dist/index.js" <<'JS'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DATA_DIR + '/nial.db');
db.exec("INSERT INTO audit (ts, actor_type, action) VALUES (1, 'system', 'MARQUEUR_VERSION_DEFECTUEUSE')");
db.close();
console.error('crash volontaire'); process.exit(1);
JS
    # package-release reconstruit dist : on empaquette a la main
    local st; st="$(mktemp -d)"; cp -r "$src/server/dist" "$st/dist"; cp "$src/server/package.json" "$src/server/package-lock.json" "$st/"
    cp -r "$src/scripts" "$src/deploy" "$st/"
    mkdir -p "$T/rel/$v"; ( cd "$st" && tar --sort=name --owner=0 --group=0 --numeric-owner -czf "$T/rel/$v/nial-control-server-$v.tar.gz" . )
    ( cd "$T/rel/$v" && sha256sum "nial-control-server-$v.tar.gz" > SHA256SUMS ); rm -rf "$st"
  else
    "$src/scripts/package-release.sh" "$T/rel/$v" >/dev/null
  fi
}
tb() { echo "$T/rel/$1/nial-control-server-$1.tar.gz"; }
sm() { echo "$T/rel/$1/SHA256SUMS"; }
health() { curl -fsS --max-time 3 2>/dev/null "http://127.0.0.1:$PORT/api/health" | grep -q '"status":"ok"'; }
users() { ( load_env; "$NODE" --no-warnings "$NIAL_ROOT/current/dist/cli.js" list-users 2>/dev/null ); }

echo "== Construction des releases de test"
build 0.1.0; build 0.1.1; build 0.1.2 mauvais
mkdir -p "$NIAL_ROOT/node/bin"; ln -s "$NODE" "$NIAL_ROOT/node/bin/node"   # evite le telechargement de Node dans le test

echo "== Installation"
"$REPO/scripts/install.sh" --tarball "$(tb 0.1.0)" --sums "$(sm 0.1.0)" >/dev/null
check "version 0.1.0 installee" '[ "$(current_version)" = 0.1.0 ]'
check "configuration creee, droits 640" '[ "$(stat -c %a "$NIAL_ETC/nial.env")" = 640 ]'
check "dossiers sensibles en 700" '[ "$(stat -c %a "$NIAL_DATA")" = 700 ] && [ "$(stat -c %a "$NIAL_BACKUPS")" = 700 ]'
svc start x 2>/dev/null || true; sleep 3
check "sans mot de passe Navidrome : le serveur refuse de demarrer avec une erreur de configuration explicite" '! health && grep -q "Configuration invalide" "$NIAL_BACKUPS/server.log"'
svc stop x || true
sed -i "s#^PORT=.*#PORT=$PORT#" "$NIAL_ETC/nial.env"; echo "mot-de-passe-navidrome-test" > "$NIAL_ETC/navidrome.pass"
( load_env; printf 'un-mot-de-passe-solide-123\n' | "$NODE" --no-warnings "$NIAL_ROOT/current/dist/cli.js" create-admin alice >/dev/null )
svc start x; for _ in $(seq 1 30); do health && break; sleep 1; done
[ -f "$NIAL_BACKUPS/server.log" ] && ! health && tail -5 "$NIAL_BACKUPS/server.log"
check "serveur 0.1.0 repond sur /api/health" health
check "administrateur cree" 'users | grep -q "^alice"'

echo "== Mise a jour 0.1.0 -> 0.1.1"
"$NIAL_ROOT/current/scripts/update.sh" --tarball "$(tb 0.1.1)" --sums "$(sm 0.1.1)" --yes >/dev/null
check "version 0.1.1 en service" '[ "$(current_version)" = 0.1.1 ] && health'
check "version precedente enregistree" '[ "$(cat "$NIAL_ROOT/previous")" = 0.1.0 ]'
check "sauvegarde pre-mise-a-jour creee (0600)" '[ "$(stat -c %a "$NIAL_BACKUPS/pre-update-0.1.0-to-0.1.1.db")" = 600 ]'
check "les donnees survivent a la mise a jour" 'users | grep -q "^alice"'

echo "== Archive alteree"
cp "$(tb 0.1.1)" "$T/alteree.tar.gz"; mkdir -p "$T/alt"; cp "$(tb 0.1.1)" "$T/alt/nial-control-server-0.1.9.tar.gz"
printf 'x' >> "$T/alt/nial-control-server-0.1.9.tar.gz"
echo "$(sha256sum "$(tb 0.1.1)" | cut -d' ' -f1)  nial-control-server-0.1.9.tar.gz" > "$T/alt/SHA256SUMS"
if "$NIAL_ROOT/current/scripts/update.sh" --tarball "$T/alt/nial-control-server-0.1.9.tar.gz" --sums "$T/alt/SHA256SUMS" --yes >/dev/null 2>&1; then ko "une archive alteree a ete acceptee"; else ok "archive alteree refusee (SHA-256)"; fi
check "rien n'a change apres le refus" '[ "$(current_version)" = 0.1.1 ] && health && [ ! -d "$NIAL_ROOT/releases/0.1.9" ]'

echo "== Archive aux chemins dangereux"
mkdir -p "$T/evil/x" "$T/evil2"; echo pwn > "$T/evil/x/f"
( cd "$T/evil" && tar --transform='s#^x/#../#' -czf "$T/evil2/nial-control-server-0.1.8.tar.gz" x/f 2>/dev/null )
( cd "$T/evil2" && sha256sum nial-control-server-0.1.8.tar.gz > SHA256SUMS )
if "$NIAL_ROOT/current/scripts/update.sh" --tarball "$T/evil2/nial-control-server-0.1.8.tar.gz" --sums "$T/evil2/SHA256SUMS" --yes >/dev/null 2>&1; then ko "archive a chemins dangereux acceptee"; else ok "archive a chemins dangereux refusee"; fi

echo "== Version defectueuse : retour arriere automatique"
if "$NIAL_ROOT/current/scripts/update.sh" --tarball "$(tb 0.1.2)" --sums "$(sm 0.1.2)" --yes >/dev/null 2>&1; then ko "la version defectueuse a ete conservee"; else ok "mise a jour defectueuse annulee"; fi
for _ in $(seq 1 30); do health && break; sleep 1; done
check "0.1.1 de nouveau en service" '[ "$(current_version)" = 0.1.1 ] && health'
check "base restauree (marqueur de la version defectueuse absent)" '( load_env; "$NODE" --no-warnings -e "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(process.argv[1],{readOnly:true});process.exit(d.prepare(\"SELECT COUNT(*) n FROM audit WHERE action=?\").get(\"MARQUEUR_VERSION_DEFECTUEUSE\").n===0?0:1)" "$DATA_DIR/nial.db" )'
check "dossier de la version defectueuse nettoye" '[ ! -d "$NIAL_ROOT/releases/0.1.2" ]'

echo "== Sauvegarde et restauration"
OUT="$("$NIAL_ROOT/current/scripts/backup.sh" | tail -n1)"
check "sauvegarde creee avec somme de controle" '[ -f "$OUT" ] && [ -f "$OUT.sha256" ] && [ "$(stat -c %a "$OUT")" = 600 ]'
# shellcheck disable=SC2034  # lue dans les chaines evaluees par check()
LISTING="$(tar -tzf "$OUT")"   # variable : evite un SIGPIPE de tar avec grep -q sous pipefail
check "la sauvegarde contient base, cle de signature et secrets de flux" '[[ "$LISTING" == *data/nial.db* && "$LISTING" == *data/server-signing.key* && "$LISTING" == *data/stream-secrets* ]]'
( load_env; printf 'un-mot-de-passe-solide-456\n' | "$NODE" --no-warnings "$NIAL_ROOT/current/dist/cli.js" create-admin bob >/dev/null )
check "bob existe avant restauration" 'users | grep -q "^bob"'
"$NIAL_ROOT/current/scripts/restore.sh" "$OUT" --yes >/dev/null
for _ in $(seq 1 30); do health && break; sleep 1; done
check "restauration : bob a disparu, alice est la, service up" '! users | grep -q "^bob" && users | grep -q "^alice" && health'
printf 'x' >> "$OUT"
if "$NIAL_ROOT/current/scripts/restore.sh" "$OUT" --yes >/dev/null 2>&1; then ko "sauvegarde alteree acceptee"; else ok "sauvegarde alteree refusee"; fi

echo "== Retour arriere manuel"
"$NIAL_ROOT/current/scripts/update.sh" --rollback --yes >/dev/null
for _ in $(seq 1 30); do health && break; sleep 1; done
check "retour a 0.1.0, service up" '[ "$(current_version)" = 0.1.0 ] && health'
check "donnees conservees apres retour arriere" 'users | grep -q "^alice"'

echo; echo "Resultat : $pass reussis, $fail echoues"; [ "$fail" -eq 0 ]
