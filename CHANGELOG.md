# Changelog

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versionnage [SemVer](https://semver.org/lang/fr/).

## [Non publie]

## [0.1.0] - 2026-11-13
### Ajoute
- Serveur central (Fastify + SQLite) : comptes (Argon2id), sessions a jeton rotatif, roles admin/utilisateur.
- Association d'appareils par code a usage unique et cle ECDSA P-256 ; revocation immediate.
- Commandes signees (Ed25519) avec numero de sequence, nonce et expiration ; file pour appareils hors ligne.
- Canal temps reel WebSocket (appareils et Controller), etat des appareils, sortie audio, progression.
- Integration Navidrome (API Subsonic) : bibliotheque, recherche, pochettes, playlists ; identifiants jamais exposes.
- Liens de flux signes (HMAC), passerelle de flux autonome et relais optionnel.
- Manifestes de telechargement avec SHA-256, mode hybride.
- Journal d'audit, CLI d'administration, sauvegarde SQLite.
- Scripts `install.sh`, `update.sh` (retour arriere automatique), `backup.sh`, `restore.sh`.
