# Politique de sécurité

## Signaler une vulnérabilité

Ne publiez **pas** de faille dans une issue publique. Utilisez *Security → Report a vulnerability* du dépôt GitHub (signalement privé). Indiquez la version, les étapes de reproduction et l'impact estimé.

Délais visés : accusé de réception sous 7 jours ; correctif sous 48 h pour une faille critique exploitable, sous 7 jours pour une faille élevée.

## Versions prises en charge

Seule la dernière version publiée reçoit des correctifs de sécurité.

## Ce que le projet garantit (et ne garantit pas)

- Les appareils s'authentifient par clé asymétrique ; les commandes sont signées, numérotées et expirent.
- Les identifiants Navidrome ne quittent jamais le serveur.
- Le partage d'écran exige le consentement système sur le téléphone et une permission explicite de l'administrateur ; il est journalisé.
- **Non garanti** : un appareil dont le système est compromis (root, malware) ou un administrateur malveillant peuvent contourner ces protections. Le projet est conçu pour gérer **vos propres appareils** ou ceux d'utilisateurs consentants.

Rapports d'audit : [`docs/audit/`](docs/audit/).
