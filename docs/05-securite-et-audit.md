# 05 — Stratégie de sécurité et d'audit avant publication

La sécurité est intégrée dès l'étape 1. L'audit final ne remplace pas les contrôles continus : il les vérifie.

## 1. Modèle de menaces (résumé)

| Acteur | Objectif possible | Défense principale |
|---|---|---|
| Attaquant sur Internet | Accéder à l'API, voler des comptes, atteindre Navidrome | TLS, limitation de débit, authentification forte, Navidrome non exposé |
| Compte utilisateur compromis | Contrôler des appareils non autorisés | Permissions par appareil, vérification serveur à chaque commande, journal d'audit |
| Appareil volé ou jeton volé | Envoyer des commandes, recevoir des données | Clé liée à l'appareil, révocation immédiate, rotation des jetons |
| Réseau hostile (Wi-Fi public) | Écoute, rejeu, modification | TLS, signature des messages, nonce, expiration |
| Dépendance malveillante | Exécution de code | Verrouillage, audit automatique, peu de dépendances |
| Utilisateur légitime mal informé | Partage d'écran non voulu | Consentement système, indicateur visible permanent, permission `screen.*` explicite |

## 2. Mesures de conception (exigences)

### Générales
- HTTPS obligatoire : redirection stricte, HSTS, protocoles TLS 1.2 minimum (TLS 1.3 de préférence).
- Mots de passe : Argon2id, longueur minimale, vérification contre une liste de mots de passe courants.
- Sessions : jeton d'accès 15 minutes, rafraîchissement rotatif, détection de réutilisation, expiration absolue, révocation depuis l'interface.
- Protection contre la force brute : limitation par compte et par adresse, délai croissant, journalisation.
- Validation stricte de toutes les entrées par schéma, requêtes SQL paramétrées uniquement, encodage des sorties.
- En-têtes de sécurité, CORS restrictif, taille maximale des corps de requête.
- Journalisation des événements sensibles : connexion, échec, association, révocation, changement de rôle, activation de permission d'écran, démarrage et arrêt de partage d'écran, activation du relais. Aucun secret ni mot de passe dans les journaux.
- Secrets hors du dépôt, fichier `.env.example` sans valeur réelle, rotation documentée.

### Appareils
- Association par code à usage unique de 10 minutes + validation explicite depuis le Controller.
- Clé privée non exportable dans le matériel sécurisé du téléphone.
- Messages sensibles signés avec nonce, horodatage, numéro de séquence ; rejet des rejeux et des commandes expirées.
- Contrôle d'autorisation côté serveur **et** côté appareil avant chaque commande sensible.

### Navidrome
- Compte dédié non administrateur, droits minimaux.
- Identifiants uniquement dans la configuration du serveur ; jamais envoyés aux applications.
- Navidrome accessible seulement depuis le proxy de flux et le serveur central ; liens signés à expiration courte pour les appareils.
- Limitation de débit par appareil sur le proxy de flux.

### Contrôle d'écran
- Aucune activation silencieuse : consentement système, notification permanente, journalisation.
- Permissions `screen.view` et `screen.control` séparées, désactivées par défaut, révocables à tout moment.
- Arrêt immédiat du partage dès la révocation de l'appareil ou la fermeture de session.

## 3. Contrôles continus (à chaque étape)

- Analyse des dépendances à chaque modification (`npm audit`, Dependabot ou Renovate, `OSV-Scanner`).
- Analyse statique du code (ESLint règles de sécurité, Semgrep, CodeQL pour le serveur ; Android Lint et détekt pour Kotlin ; SwiftLint pour Swift).
- Détection de secrets à chaque commit (Gitleaks ou TruffleHog, en hook local et en CI).
- Tests automatisés de sécurité de l'API à chaque version (authentification, autorisations, rejeu).
- Analyse des images ou paquets de déploiement avant release.

## 4. Audit complet avant publication

Réalisé à l'étape 11, sur la version `v1.0.0-rc1`, dans un **environnement de test isolé** avec des données factices.

| # | Contrôle | Méthode et outils | Livrable |
|---|---|---|---|
| 1 | Dépendances | `npm audit`, OSV-Scanner, `gradle` dependency-check (OWASP), SBOM (CycloneDX) | Liste des paquets et des vulnérabilités |
| 2 | Vulnérabilités connues | Croisement du SBOM avec les bases CVE/OSV | Tableau de gravité |
| 3 | Analyse statique | Semgrep, CodeQL, Android Lint, SwiftLint | Rapport de constats |
| 4 | Sécurité des API | Tests basés sur OWASP API Security Top 10 : autorisation au niveau des objets, injection, exposition excessive de données, limitation de débit ; ZAP en analyse active sur le test | Constats reproductibles |
| 5 | Authentification | Force brute, énumération de comptes, réutilisation de jetons, expiration, rotation | Résultats des tests |
| 6 | Permissions | Matrice rôle × appareil × action testée automatiquement, y compris les accès horizontaux (utilisateur A vers appareil de B) | Matrice validée |
| 7 | HTTPS/TLS | `testssl.sh`, vérification HSTS, certificats, redirections, protocoles | Rapport TLS |
| 8 | Secrets exposés | Gitleaks sur tout l'historique, recherche dans les APK et IPA (chaînes), journaux, variables | Rapport de secrets (zéro attendu) |
| 9 | Communications entre appareils | Tentatives de rejeu, falsification de signature, commande expirée, séquence invalide, usurpation d'identifiant d'appareil | Résultats des tests |
| 10 | Applications clientes | Revue du manifeste Android, stockage local (pas de secret en clair), `allowBackup`, composants exportés, journalisation, vérification des certificats ; analyse de l'APK avec MobSF | Rapport mobile |
| 11 | Gestion des sessions | Révocation, expiration, déconnexion globale, détection de réutilisation | Résultats des tests |
| 12 | Sauvegardes | Restauration complète sur LXC vierge, chiffrement des sauvegardes, droits d'accès, durée de restauration | Procès-verbal de restauration |
| 13 | Infrastructure | Scan de ports (`nmap`), pare-feu, services exposés, droits du service, isolation du LXC, durcissement SSH, mises à jour du système | Rapport d'infrastructure |

Limites de portée : les tests offensifs ne sont menés que sur l'environnement de test appartenant à l'utilisateur, jamais sur un système tiers.

## 5. Rapport d'audit

Fichier : `docs/audit/AAAA-MM-JJ-audit-vX.Y.Z.md`, avec pour chaque constat :

- Identifiant (`NC-001`…), titre, composant concerné.
- Gravité : Critique, Élevée, Moyenne, Faible, Informative (échelle CVSS v3.1 ou v4.0, indiquée dans le rapport).
- Description, preuve de reproduction, impact.
- Correctif appliqué (référence du commit ou de la version).
- Résultat du test après correction.
- Statut : ouvert, corrigé, risque accepté (avec justification écrite et signature).

## 6. Critères de publication

La version `v1.0.0` n'est publiée que si :

1. Aucune vulnérabilité critique ou élevée connue n'est ouverte (corrigée, ou traitée formellement par un risque accepté documenté).
2. Les tests automatisés passent, y compris les tests de sécurité.
3. Un nouveau passage de contrôle confirme chaque correctif.
4. Une restauration de sauvegarde et un retour arrière de mise à jour ont été testés avec succès.
5. `INSTALLATION.md`, `UPDATE.md` et le CHANGELOG sont à jour.
6. Les artefacts de release sont signés et accompagnés de leurs sommes de contrôle.

## 7. Exploitation après publication

- Politique de signalement de vulnérabilités (`SECURITY.md`).
- Surveillance : santé du service, taux d'échec de connexion, volume de relais, alertes (e-mail ou webhook).
- Mises à jour de sécurité : suivi hebdomadaire des dépendances, release corrective sous 7 jours pour une faille élevée, sous 48 h pour une faille critique exploitable.
- Réaudit à chaque version majeure et après tout changement du protocole d'authentification ou de contrôle d'écran.
