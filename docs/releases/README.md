# Versions et notes d'installation

Chaque version publiée a sa fiche d'installation. Les versions `0.x` sont des **préversions** : le protocole et la base peuvent évoluer entre deux versions mineures (indiqué dans chaque fiche).

| Version | Contenu | Statut | Fiche |
|---|---|---|---|
| 0.1.0 | Serveur central complet (comptes, appareils, temps réel, Navidrome, flux signés, téléchargements) | Préversion | [v0.1.0](v0.1.0/INSTALLATION.md) |

Procédure générale : [`INSTALLATION.md`](../../INSTALLATION.md) · Mise à jour : [`UPDATE.md`](../../UPDATE.md) · Historique : [`CHANGELOG.md`](../../CHANGELOG.md)

## Règles de versionnage

- `MAJEUR.MINEUR.CORRECTIF` ([SemVer](https://semver.org/lang/fr/)). `CORRECTIF` : corrections sans changement de comportement ; `MINEUR` : fonctionnalités compatibles ; `MAJEUR` : changement incompatible.
- Suffixe `-rcN` : version candidate, publiée comme préversion GitHub, jamais proposée par `update.sh` sans `--allow-prerelease`.
- Chaque release GitHub contient `nial-control-server-X.Y.Z.tar.gz`, `SHA256SUMS` et, quand les applications existent pour cette version, les APK/IPA avec leurs sommes.
