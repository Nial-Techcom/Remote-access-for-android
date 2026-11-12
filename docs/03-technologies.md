# 03 — Choix techniques et justifications

Principes : stabilité avant nouveauté, technologies documentées et maintenables par une seule personne, déploiement simple dans un LXC Proxmox, compatibilité mobile.

## 1. Tableau récapitulatif

| Domaine | Choix recommandé | Alternative étudiée |
|---|---|---|
| Backend | Node.js 22 LTS + TypeScript + Fastify | Go ; Python (FastAPI) |
| Base de données | SQLite (mode WAL) au départ, migrations prêtes pour PostgreSQL | PostgreSQL d'emblée |
| API | REST JSON documentée en OpenAPI, validation par schémas | GraphQL |
| Temps réel | WebSocket (bibliothèque `ws` intégrée à Fastify) | MQTT ; Server-Sent Events |
| Client Android | Kotlin natif, Media3 (ExoPlayer), WorkManager, service de premier plan | Flutter |
| Client iOS | Swift natif, AVFoundation, URLSession en arrière-plan | Flutter |
| Controller | Flutter (Android et iOS depuis un seul code) | Deux apps natives ; React Native |
| Téléchargement | HTTP `Range` + SHA-256 + fichiers `.part` | BitTorrent, rsync (inadaptés au mobile) |
| Lecteur audio | Media3 (Android), AVPlayer (iOS) | Lecteur partagé Flutter |
| Capture d'écran | `MediaProjection` + encodage H.264 + WebRTC | JPEG par WebSocket (prototype) |
| Sécurité | Argon2id, JWT courts + refresh rotatifs, clés d'appareil asymétriques, HMAC pour les liens | Sessions à cookies pour le Controller |
| Reverse proxy | Caddy (TLS automatique) | Traefik, Nginx |
| Déploiement | Conteneur LXC Debian + service systemd, Docker Compose en option | VM complète |

## 2. Justifications

### Backend : Node.js + TypeScript + Fastify
- Le serveur est surtout **entrées/sorties** (WebSocket, HTTP, base) : Node convient très bien pour des dizaines à quelques centaines de connexions.
- TypeScript permet de **partager les types de messages** entre serveur et Controller (génération depuis un schéma commun), ce qui réduit les erreurs de protocole.
- Fastify est rapide, a une validation par schéma intégrée (protection des entrées) et un écosystème de sécurité mature (limitation de débit, en-têtes).
- Go serait plus léger en mémoire et excellent pour ce profil ; il est écarté uniquement par la courbe d'apprentissage et le partage de types. À réévaluer si la charge l'exige.

### Base de données : SQLite d'abord
- Usage personnel : une seule instance, écriture modérée. SQLite en mode WAL est fiable, sans service à administrer, et la sauvegarde est un simple fichier (avec `VACUUM INTO` ou l'API de sauvegarde).
- Accès par couche de requêtes paramétrées (Drizzle ORM ou Kysely) : **aucune concaténation SQL**, ce qui répond à la protection contre les injections.
- La couche d'accès reste compatible PostgreSQL pour migrer sans réécriture si le nombre d'utilisateurs augmente.

### API et temps réel
- REST pour les opérations ponctuelles (connexion, bibliothèque, association, administration), OpenAPI pour documenter et tester.
- WebSocket pour les commandes et les états : bidirectionnel, faible latence, bien supporté sur mobile. MQTT est solide mais ajoute un courtier à exploiter et à sécuriser pour un gain faible ici.

### Clients natifs pour les téléphones distants
- Les fonctions critiques (service de premier plan, `MediaProjection`, `AccessibilityService`, sortie audio, téléchargements en arrière-plan) sont **propres à chaque plateforme** et mal couvertes par les frameworks multiplateformes.
- Android en Kotlin natif avec Media3 : gestion de session média, reprise, mise en cache, sortie Bluetooth.
- iOS en Swift avec AVFoundation et sessions de téléchargement en arrière-plan.

### Controller en Flutter
- L'interface (tableau de bord, lecteurs multiples, bibliothèque, vue d'écran) est riche mais **sans accès bas niveau au système** : un code unique pour Android et iOS est rentable.
- Rendu fluide et thème sombre cohérent.
- La vue d'écran distant utilise un composant WebRTC (paquet `flutter_webrtc`).

### Téléchargement
- HTTP standard avec `Range` : compatible avec les proxys, simple à tester, reprise native.
- Empreinte SHA-256 par morceau et écriture atomique : intégrité garantie et pas de fichier corrompu lu par erreur.

### Capture d'écran (Android)
- `MediaProjection` → encodeur matériel H.264 → WebRTC (chiffrement DTLS-SRTP obligatoire, adaptation du débit, faible latence). Un serveur de signalisation léger passe par la passerelle WebSocket ; un serveur TURN (coturn) est nécessaire pour les réseaux restrictifs.
- Prototype de départ possible en images JPEG sur WebSocket pour valider l'ergonomie, puis migration vers WebRTC.

### Sécurité
- Mots de passe : Argon2id avec sel unique par mot de passe.
- Jetons : accès courts, rafraîchissement rotatif avec détection de réutilisation (révocation de la famille de jetons).
- Appareils : clé privée non exportable (Android Keystore, iOS Secure Enclave quand disponible), signature des défis de connexion et des messages sensibles.
- Liens de flux : HMAC-SHA256 avec secret rotatif, expiration courte, liés à l'appareil.
- Secrets du serveur : variables d'environnement ou fichiers de secrets en lecture seule (`systemd` credentials), jamais dans le dépôt.

## 3. Dépendances et risques de chaque choix

| Choix | Risque | Atténuation |
|---|---|---|
| Écosystème npm | Chaîne d'approvisionnement | Verrouillage des versions, `npm audit` en CI, peu de dépendances, revue des mises à jour |
| WebRTC | Complexité (TURN, NAT) | Phase tardive, prototype simple d'abord, désactivable |
| Flutter | Mises à jour fréquentes | Version figée par release, tests d'interface |
| SQLite | Un seul nœud | Sauvegardes testées, chemin de migration PostgreSQL |
| Distribution hors stores | Pas de mise à jour automatique | Procédure `update.md` / `update.sh` côté serveur, vérificateur de version dans l'application |

## 4. Documents de déploiement prévus (étapes ultérieures)

Ces fichiers seront produits au moment de la mise en place du serveur, après validation de la phase 1 :
- `INSTALLATION.md` : installation pas à pas dans un LXC Debian sur Proxmox, variables d'environnement, reverse proxy.
- `UPDATE.md` et `update.sh` : mise à jour contrôlée avec sauvegarde préalable, vérification d'intégrité, test de santé et retour arrière automatique.
- `CHANGELOG.md` et versionnage sémantique (`vMAJEUR.MINEUR.CORRECTIF`) avec une release GitHub par version, artefacts signés et sommes de contrôle.
- Rapport d'audit de sécurité final et suivi des corrections.
