# Mise à jour et retour arrière

Le script [`scripts/update.sh`](scripts/update.sh) met à jour le serveur **sans toucher à la version en service tant que la nouvelle n'est pas prête**, puis bascule, vérifie, et revient seul en arrière en cas d'échec.

Après l'installation, une copie des scripts se trouve dans `/opt/nial-control/current/scripts/`.

## Commandes

```bash
sudo /opt/nial-control/current/scripts/update.sh --check              # version installée / dernière release
sudo /opt/nial-control/current/scripts/update.sh                      # met à jour vers la dernière release stable
sudo /opt/nial-control/current/scripts/update.sh --version 0.2.0      # version précise
sudo /opt/nial-control/current/scripts/update.sh --allow-prerelease   # inclut les versions rc
sudo /opt/nial-control/current/scripts/update.sh --tarball F --sums S # hors ligne, depuis des fichiers locaux
sudo /opt/nial-control/current/scripts/update.sh --rollback           # revient à la version précédente
```

Avant de lancer : lisez le [`CHANGELOG.md`](CHANGELOG.md) et la fiche de la version dans [`docs/releases/`](docs/releases/README.md) (changements incompatibles, migrations de base de données, mise à jour simultanée des applications).

## Ce que fait une mise à jour

1. **Verrou** : une seule mise à jour à la fois.
2. **Téléchargement** de l'archive et de `SHA256SUMS` en HTTPS strict (TLS ≥ 1.2).
3. **Vérification SHA-256** : toute archive altérée est refusée avant toute extraction. Refus aussi si l'archive contient un chemin absolu ou `..`.
4. **Espace disque** : au moins 300 Mo libres, sinon abandon sans rien modifier.
5. **Sauvegarde préalable** : copie cohérente de la base (`pre-update-<ancienne>-to-<nouvelle>.db`, droits 600) + sauvegarde complète (base, clés, configuration).
6. **Installation à côté** dans `releases/<version>` ; `npm ci --omit=dev --ignore-scripts` (aucun script d'installation de dépendance n'est exécuté). La version en service n'est pas touchée.
7. **Bascule atomique** du lien `current`, redémarrage du service.
8. **Contrôle de santé** (`/api/health`, 45 s). **En cas d'échec : retour automatique** — service arrêté, base restaurée depuis la sauvegarde de l'étape 5, ancienne version relancée, dossier de la nouvelle version supprimé.
9. **Ménage** : les 3 dernières versions sont conservées.

Journal : `/var/log/nial-control-update.log`.

## Retour arrière manuel

```bash
sudo /opt/nial-control/current/scripts/update.sh --rollback
```

Revient à la version précédente **et restaure la base d'avant la mise à jour**. Conséquence : les données créées depuis la mise à jour (commandes, journaux, sessions) sont perdues ; une copie de la base actuelle est conservée dans `/var/backups/nial-control/avant-rollback-*.db`.

Pourquoi restaurer la base : une version plus récente peut avoir modifié le schéma (migrations). Une version plus ancienne **refuse de démarrer** sur une base plus récente qu'elle (`La base de données est en version N, plus récente que ce serveur`) plutôt que de risquer de la corrompre. Si vous voyez ce message après un retour manuel, restaurez la sauvegarde :

```bash
sudo systemctl stop nial-control
sudo install -m 600 /var/backups/nial-control/pre-update-<ancienne>-to-<nouvelle>.db /var/lib/nial-control/nial.db
sudo chown nial:nial /var/lib/nial-control/nial.db
sudo systemctl start nial-control
```

## Applications mobiles

Les applications et le serveur communiquent via un protocole versionné (`v` dans chaque message signé). Une mise à jour **mineure** (0.x.y → 0.x.z) reste compatible dans les deux sens. Une mise à jour qui change le protocole le dit explicitement dans sa fiche de version : mettez alors à jour le serveur **d'abord**, puis les applications. Les applications ne sont pas mises à jour automatiquement (distribution hors stores) : installez le nouvel APK / la nouvelle IPA de la release.

## Vérifier les sources avant d'exécuter

Les scripts sont dans le dépôt et dans chaque archive. Pour auditer avant de lancer :

```bash
tar -xzf nial-control-server-X.Y.Z.tar.gz ./scripts && less scripts/update.sh
```

## Tester la procédure

`scripts/test-update-cycle.sh` rejoue, dans un dossier temporaire et sans systemd, une installation, une mise à jour, une archive altérée, une version défectueuse (retour automatique), une sauvegarde/restauration et un retour manuel (24 vérifications).
