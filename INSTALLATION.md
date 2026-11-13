# Installation du serveur NIAL CONTROL

Ce guide installe le **serveur central** dans un conteneur LXC (ou une VM) Debian sur Proxmox. L'installation des applications mobiles est décrite dans [`docs/releases/`](docs/releases/README.md), version par version.

> Ne mettez **pas** le serveur sur Internet avant d'avoir lu [la section sécurité](#6-exposer-le-serveur-sur-internet) et [le rapport d'audit](docs/audit/).

## 1. Prérequis

| Élément | Minimum | Pourquoi |
|---|---|---|
| Système | Debian 12/13 ou Ubuntu 22.04+ (LXC non privilégié convient) | Le script d'installation cible systemd |
| Ressources | 1 vCPU, 512 Mo de RAM, 4 Go de disque | Le serveur ne transporte pas l'audio (sauf relais) |
| Navidrome | Accessible depuis le serveur en HTTP/HTTPS | Source de la bibliothèque musicale |
| Nom de domaine | Pointant vers votre IP publique (accès hors du réseau local) | Certificat TLS Let's Encrypt |
| Accès sortant | `github.com`, `nodejs.org`, `registry.npmjs.org` | Téléchargement de la release, de Node.js et des dépendances |

Node.js est installé par le script dans `/opt/nial-control/node` (version épinglée, somme SHA-256 vérifiée) : le Node.js du système n'est pas utilisé et reste intact.

## 2. Créer le conteneur (Proxmox)

Interface web : *Créer un CT* → modèle `debian-13-standard` → 1 cœur, 512 Mo de RAM (+ 512 Mo de swap), 4 Go de disque → **« Unprivileged container » coché** → réseau en DHCP ou IP fixe. Aucune option spéciale (nesting, FUSE…) n'est requise.

En ligne de commande sur l'hôte Proxmox :

```bash
pct create 210 local:vztmpl/debian-13-standard_13.0-1_amd64.tar.zst \
  --hostname nial --cores 1 --memory 512 --swap 512 \
  --rootfs local-lvm:4 --unprivileged 1 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp --onboot 1
pct start 210 && pct enter 210
apt-get update && apt-get install -y curl ca-certificates xz-utils
```

(Adaptez le numéro, le stockage et le nom du modèle : `pveam list local`.)

## 3. Créer un compte Navidrome dédié

Dans l'interface de Navidrome → *Utilisateurs* → créez `nial-service`, **sans** droit administrateur, avec un mot de passe long et unique. Le serveur NIAL n'utilise que ce compte ; les téléphones ne reçoivent **jamais** d'identifiant Navidrome, seulement des liens signés à durée courte.

## 4. Installer le serveur

Remplacez `0.1.0` par la version voulue (voir [`CHANGELOG.md`](CHANGELOG.md) et [`docs/releases/`](docs/releases/README.md)).

```bash
VERSION=0.1.0
BASE=https://github.com/Flunch4456/Remote-access-for-android/releases/download/v$VERSION
cd /root && mkdir -p nial-install && cd nial-install
curl -fsSLO $BASE/nial-control-server-$VERSION.tar.gz
curl -fsSLO $BASE/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS            # doit afficher : ...tar.gz: OK
tar -xzf nial-control-server-$VERSION.tar.gz ./scripts
sudo ./scripts/install.sh --tarball nial-control-server-$VERSION.tar.gz --sums SHA256SUMS
```

Le script : crée l'utilisateur système `nial` (sans shell), installe Node.js et le serveur dans `/opt/nial-control/releases/<version>` (lien `current`), installe les unités systemd (service durci + sauvegarde quotidienne), crée `/etc/nial-control/nial.env`, et **ne démarre rien** tant que la configuration n'est pas faite.

Emplacements :

| Chemin | Contenu | Droits |
|---|---|---|
| `/opt/nial-control/` | Node.js, versions installées, lien `current` | root |
| `/etc/nial-control/nial.env` | Configuration | `640 root:nial` |
| `/etc/nial-control/navidrome.pass` | Mot de passe du compte Navidrome | `640 root:nial` |
| `/var/lib/nial-control/` | Base SQLite, clé de signature, secrets de flux | `700 nial` |
| `/var/backups/nial-control/` | Sauvegardes | `700 root` |

## 5. Configurer et démarrer

```bash
sudo nano /etc/nial-control/nial.env        # PUBLIC_URL, NAVIDROME_URL, NAVIDROME_USER
sudo sh -c 'umask 077; cat > /etc/nial-control/navidrome.pass' # collez le mot de passe puis Ctrl+D
sudo chmod 640 /etc/nial-control/navidrome.pass && sudo chown root:nial /etc/nial-control/navidrome.pass

# Premier administrateur (le mot de passe est saisi sans écho, 12 caractères minimum)
sudo -u nial env DATA_DIR=/var/lib/nial-control \
  /opt/nial-control/node/bin/node /opt/nial-control/current/dist/cli.js create-admin <identifiant>

sudo systemctl start nial-control
curl -s http://127.0.0.1:8080/api/health      # {"status":"ok"}
journalctl -u nial-control -n 50 --no-pager
```

Le serveur refuse de démarrer, avec un message clair, si `PUBLIC_URL` n'est pas en HTTPS (en production), si le mot de passe Navidrome est vide, ou si ni `STREAM_BASE_URL` ni `RELAY_ENABLED=1` n'est défini.

**Choix du mode de flux audio** (dans `nial.env`) :

- `RELAY_ENABLED=1` — le serveur relaie l'audio. Le plus simple : un seul point d'entrée. Le serveur consomme de la bande passante pendant la lecture.
- `STREAM_BASE_URL=https://stream.exemple.org` — **flux direct** : une passerelle de flux (`dist/gateway.js`, port 8081) est placée près de Navidrome ; les téléphones lui parlent directement, le serveur central ne voit jamais l'audio. Elle doit partager `STREAM_SECRETS_FILE` avec le serveur. Recommandé dès que plusieurs téléphones jouent en même temps.

## 6. Exposer le serveur sur Internet

Vous avez deux approches ; choisissez en connaissance de cause.

| | Reverse proxy public (Caddy) | VPN (Tailscale / WireGuard) |
|---|---|---|
| Installation sur les téléphones | Aucune | Application VPN, toujours active |
| Surface d'attaque | Port 443 exposé à Internet | Aucun port ouvert |
| Complexité | Faible | Moyenne ; **un seul VPN actif à la fois sur iOS** |
| Pour qui | Usage quotidien simple | Exigence de discrétion maximale |

**Reverse proxy** — installez Caddy (`apt install caddy`), reprenez [`deploy/caddy/Caddyfile`](deploy/caddy/Caddyfile) en remplaçant le nom de domaine, puis `systemctl reload caddy`. Ouvrez 80 et 443 uniquement (pare-feu Proxmox ou box). Gardez `HOST=127.0.0.1` : le port 8080 ne doit jamais être joignable depuis l'extérieur.

Contrôles minimaux avant d'ouvrir :

```bash
curl -sI https://nial.exemple.org/api/health | grep -i strict-transport      # HSTS présent
curl -s  https://nial.exemple.org/api/devices                                 # {"error":"Authentification requise"}
nmap -p 8080,8081 <ip-publique>                                               # doivent être filtrés
```

## 7. Sauvegardes

Une sauvegarde quotidienne (03h30) est installée (`nial-backup.timer`) : base, clé de signature, secrets de flux, configuration, avec somme SHA-256 et rétention de 14 exemplaires.

```bash
sudo /opt/nial-control/current/scripts/backup.sh                 # sauvegarde manuelle
sudo systemctl list-timers nial-backup.timer
# Chiffrement (recommandé si vous copiez les sauvegardes hors du serveur) :
echo 'une-phrase-longue' | sudo tee /root/.nial-backup-pass >/dev/null && sudo chmod 600 /root/.nial-backup-pass
# puis ajoutez  Environment=BACKUP_PASSPHRASE_FILE=/root/.nial-backup-pass  dans nial-backup.service
sudo /opt/nial-control/current/scripts/restore.sh /var/backups/nial-control/nial-backup-<date>.tar.gz
```

**Copiez les sauvegardes hors du conteneur** (autre machine, stockage Proxmox Backup Server…). **Sauvegardez aussi le conteneur lui-même** via la sauvegarde Proxmox habituelle. La clé `server-signing.key` est vitale : si elle est perdue, tous les téléphones doivent être ré-associés.

## 8. Mises à jour et retour arrière

Voir [`UPDATE.md`](UPDATE.md).

## 9. Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| `Configuration invalide : …` au démarrage | Variable manquante ou incorrecte | `journalctl -u nial-control -n 20`, corriger `nial.env` |
| `/api/status` indique `"navidrome": false` | URL, compte ou mot de passe Navidrome incorrect | Tester `curl $NAVIDROME_URL/rest/ping.view?u=…` |
| Les téléphones ne se connectent pas | Le proxy ne laisse pas passer les WebSocket, ou `PUBLIC_URL` incorrect | Vérifier `wss://…/ws/device` ; Caddy gère les WebSocket par défaut |
| Toutes les IP apparaissent comme `127.0.0.1` | `TRUST_PROXY=0` derrière un proxy | Mettre `TRUST_PROXY=1` (uniquement derrière un proxy local de confiance) |
| La lecture démarre puis s'arrête (`429`) | Plus de 4 transferts simultanés pour un appareil | Normal : limite de protection |
| `La base de données est en version N, plus récente…` | Retour arrière sans restaurer la base | Voir `UPDATE.md`, section « Retour arrière » |

## 10. Désinstallation

```bash
sudo systemctl disable --now nial-control nial-backup.timer
sudo rm -rf /opt/nial-control /etc/systemd/system/nial-*.{service,timer}
# Données et sauvegardes : supprimez-les seulement si vous êtes certain
# sudo rm -rf /var/lib/nial-control /etc/nial-control /var/backups/nial-control
sudo userdel nial
```
