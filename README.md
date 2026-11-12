# NIAL CONTROL

Plateforme personnelle auto-hébergée pour gérer plusieurs téléphones depuis un téléphone principal : commandes à distance, bibliothèque Navidrome, lecture en streaming ou hors ligne, sortie Bluetooth indépendante par téléphone, et, sur Android, visualisation et contrôle de l'écran avec consentement.

**État du projet : phase 1 (analyse et conception). Aucun code applicatif n'est encore écrit.**

## Composants

| Composant | Rôle |
|---|---|
| Serveur central | Comptes, appareils, commandes temps réel, métadonnées Navidrome, liens de flux signés, journaux |
| Client | Application des téléphones distants : lecteur, téléchargements, Bluetooth, capture d'écran (Android) |
| Controller | Application du téléphone principal : tableau de bord, lecteurs multiples, bibliothèque |

## Documentation de conception

1. [Faisabilité et limites Android / iOS](docs/01-faisabilite.md)
2. [Architecture et schémas](docs/02-architecture.md)
3. [Choix techniques](docs/03-technologies.md)
4. [Structure, complexité et plan par étapes](docs/04-structure-complexite-plan.md)
5. [Sécurité et audit avant publication](docs/05-securite-et-audit.md)

## Feuille de route

Le développement avance par étapes validées une à une (v0.1.0 à v1.0.0). `INSTALLATION.md`, `UPDATE.md`, `update.sh`, les releases versionnées et l'audit de sécurité avec corrections sont prévus aux étapes 10 à 12 du plan.

## Principes

- Chaque étape est testée et validée avant la suivante.
- Aucun contournement des mécanismes de sécurité d'Android ou d'iOS.
- Aucune exposition sur Internet avant l'audit de sécurité.
