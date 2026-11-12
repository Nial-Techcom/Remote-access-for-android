# 04 — Structure du dépôt, complexité et plan de développement

## 1. Structure de dossiers proposée (monorepo)

```
Remote-access-for-android/
├── README.md
├── CHANGELOG.md
├── LICENSE
├── docs/
│   ├── 01-faisabilite.md
│   ├── 02-architecture.md
│   ├── 03-technologies.md
│   ├── 04-structure-complexite-plan.md
│   ├── 05-securite-et-audit.md
│   ├── protocole/            # schémas des messages temps réel, versions du protocole
│   └── audit/                # rapports d'audit datés et suivi des corrections
├── packages/
│   └── protocol/             # types et schémas partagés (messages, erreurs, permissions)
├── server/
│   ├── src/
│   │   ├── modules/          # auth, users, devices, pairing, commands,
│   │   │                     # realtime, navidrome, streams, downloads, audit, health
│   │   ├── plugins/          # sécurité, limitation de débit, journalisation
│   │   ├── db/               # schéma, migrations, requêtes
│   │   └── config/           # lecture et validation des variables d'environnement
│   ├── test/                 # unitaires, intégration, sécurité
│   └── .env.example
├── apps/
│   ├── android-client/       # Kotlin : lecteur, téléchargements, capture, accessibilité
│   ├── ios-client/           # Swift : lecteur, téléchargements (capture en option)
│   └── controller/           # Flutter : tableau de bord, lecteurs, bibliothèque, vue écran
├── deploy/
│   ├── proxmox-lxc/          # gabarit et notes LXC
│   ├── caddy/                # Caddyfile, proxy de flux avec liens signés
│   ├── systemd/              # unités de service
│   ├── docker/               # Docker Compose optionnel
│   └── backup/               # scripts de sauvegarde et de restauration
├── scripts/
│   ├── install.sh            # installation
│   ├── update.sh             # mise à jour avec retour arrière
│   └── check-release.sh      # vérification des sommes de contrôle
├── INSTALLATION.md           # (étape ultérieure)
├── UPDATE.md                 # (étape ultérieure)
└── .github/
    └── workflows/            # tests, analyse de dépendances, builds, releases
```

Environnements : `dev` (poste local), `test` (instance isolée avec données factices et Navidrome de test), `prod` (LXC dédié). Chaque environnement a sa configuration, ses secrets et sa base ; aucun secret partagé.

## 2. Estimation de complexité par fonctionnalité

Échelle : 1 = simple (quelques jours) ; 3 = moyen (1 à 2 semaines) ; 5 = complexe (plusieurs semaines, risque technique réel). Les durées sont indicatives pour une personne travaillant à temps partiel.

| Fonctionnalité | Complexité | Commentaire |
|---|---|---|
| Comptes, sessions, rôles | 3 | Standard mais sensible : à soigner |
| Association sécurisée des appareils | 3 | Clés d'appareil, code à usage unique |
| Canal temps réel et reconnexion | 3 | La robustesse (ordre, rejeu, reprise) coûte plus que la fonction |
| Intégration Navidrome (bibliothèque, pochettes, recherche) | 2 | API Subsonic bien documentée |
| Liens de flux signés et proxy | 3 | Configuration de proxy et rotation des secrets |
| Lecture en streaming sur le client Android | 2 | Media3 |
| Lecture en streaming sur le client iOS | 3 | Contraintes d'arrière-plan |
| Commandes de lecture à distance (play, pause, suivant, volume) | 2 | Une fois le canal fiable |
| Téléchargement hors ligne (manifeste, reprise, intégrité) | 4 | Reprise, espace disque, déduplication, mises à jour |
| Mode hybride avec bascule automatique | 4 | Détection de coupure, état cohérent |
| Relais audio optionnel | 3 | Protection de charge du serveur |
| Affichage de la sortie Bluetooth | 2 | Lecture seule, API système |
| Changement de sortie audio à distance (Android) | 4 | Dépend de la version Android, à valider en test réel |
| Changement de sortie audio à distance (iOS) | Impossible | Non réalisable |
| Tableau de bord et gestion d'appareils | 2 | Interface |
| Lecteurs multiples indépendants dans le Controller | 3 | Gestion d'état par appareil |
| Visualisation d'écran Android (WebRTC) | 5 | Capture, encodage, TURN, consentement |
| Contrôle tactile Android (accessibilité) | 4 | Gestes, latence, restrictions système |
| Visualisation d'écran iOS | 4 | Démarrage manuel, extension limitée en mémoire |
| Contrôle tactile iOS | Impossible | Aucune API publique |
| Journal d'audit et surveillance | 2 | Structuré dès le départ |
| Sauvegardes, mise à jour, retour arrière | 3 | Essentiel pour la production |
| Audit de sécurité complet et corrections | 4 | Travail continu |

## 3. Plan de développement par étapes

Règle : **chaque étape est testée et validée avant de commencer la suivante**. Une étape = une version (tag Git) et une entrée du CHANGELOG.

| Étape | Contenu | Critère de validation | Version cible |
|---|---|---|---|
| 0 | Phase 1 : analyse et architecture (documents actuels) | Validation de l'utilisateur | — |
| 1 | Socle serveur : configuration, base, comptes, sessions, journal, santé, déploiement LXC de dev | Tests d'authentification passent, service démarre, sauvegarde et restauration testées | v0.1.0 |
| 2 | Association d'appareils et canal temps réel (messages signés, rejeu refusé, reconnexion) | Un client factice s'associe, reçoit une commande, se reconnecte après coupure | v0.2.0 |
| 3 | Intégration Navidrome : bibliothèque, pochettes, recherche, compte dédié | Parcours complet depuis l'API, aucun identifiant Navidrome renvoyé aux clients | v0.3.0 |
| 4 | Client Android : streaming Media3, commandes de lecture, sortie audio affichée | Deux téléphones lisent deux playlists différentes en même temps | v0.4.0 |
| 5 | Controller Flutter : tableau de bord, bibliothèque, lecteurs multiples | Contrôle de plusieurs téléphones depuis un téléphone principal | v0.5.0 |
| 6 | Liens signés et proxy de flux, relais optionnel | Lien expiré ou falsifié refusé, Navidrome non joignable directement | v0.6.0 |
| 7 | Téléchargement hors ligne et mode hybride | Interruption réseau en cours de téléchargement reprise, intégrité vérifiée, bascule locale | v0.7.0 |
| 8 | Client iOS (lecture, commandes, téléchargements) | Parité fonctionnelle documentée avec les limites iOS | v0.8.0 |
| 9 | Visualisation d'écran Android puis contrôle tactile | Consentement obligatoire, indicateur visible, révocation immédiate | v0.9.0 |
| 10 | Installation, mise à jour, retour arrière, documentation finale | `INSTALLATION.md`, `UPDATE.md` et `update.sh` testés sur LXC vierge | v0.10.0 |
| 11 | Audit de sécurité complet (voir `05-securite-et-audit.md`) | Rapport publié | v1.0.0-rc1 |
| 12 | Correction des failles et nouveau test | Aucune vulnérabilité critique ou élevée ouverte | v1.0.0 |

Chaque release GitHub contient : l'archive du serveur, les APK signés, les sommes de contrôle SHA-256 et les notes de version issues du CHANGELOG.

## 4. Stratégie de tests par étape

- **Unitaires** : logique d'authentification, validation de messages, génération et vérification de liens, calcul de manifestes.
- **Intégration** : serveur + base + Navidrome de test.
- **Multi-appareils** : au moins un client factice automatisé, puis des appareils réels.
- **Streaming et téléchargement** : coupures simulées, taux de perte, reprise.
- **Bluetooth** : tests manuels sur appareils réels (enceinte, casque), car non automatisables.
- **Reconnexion** : passage en mode avion, changement de réseau, redémarrage du serveur.
- **Sécurité** : voir le document suivant.
- **Performances** : montée en charge simulée (par exemple 50 clients factices), mesure de la mémoire et du processeur du LXC.
