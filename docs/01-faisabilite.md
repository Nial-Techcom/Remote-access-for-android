# 01 — Analyse de faisabilité et limites Android / iOS

> Phase 1 du projet NIAL CONTROL. Document d'analyse : aucun code applicatif n'est écrit à ce stade.
> Les limites de plateforme décrites ici sont celles connues à la date de rédaction ; elles évoluent à chaque version d'Android et d'iOS et doivent être revérifiées avant chaque étape de développement.

## 1. Verdict global

| Bloc fonctionnel | Android (client) | iOS (client) | Verdict |
|---|---|---|---|
| Enregistrement et association sécurisée | Oui | Oui | Faisable partout |
| Commandes de lecture (play, pause, suivant, volume) | Oui | Oui (app au premier plan ou audio actif) | Faisable |
| Streaming direct Navidrome vers le téléphone | Oui | Oui | Faisable |
| Téléchargement hors ligne et vérification d'intégrité | Oui | Oui (limites d'arrière-plan) | Faisable |
| Mode hybride avec bascule automatique | Oui | Oui | Faisable |
| État du téléphone (batterie, réseau) | Oui | Oui (batterie et réseau, pas de détails système) | Faisable |
| Détection de la sortie audio (Bluetooth) | Oui | Oui (lecture seule) | Faisable |
| Choix de la sortie audio à distance | Partiel | Non | Limité, voir §3 |
| Affichage de l'écran à distance | Oui, avec accord de l'utilisateur du téléphone | Partiel, démarrage manuel obligatoire | Limité, voir §2 |
| Contrôle tactile à distance | Oui, via service d'accessibilité activé manuellement | Non | Android uniquement |
| Fonctionnement sans aucune validation manuelle | Non | Non | Impossible par conception |

**Conclusion.** Le cœur du projet (commandes, Navidrome, streaming, téléchargement, hybride, lecture multi-appareils) est réalisable sur les deux plateformes. Le contrôle d'écran est réalisable sur Android avec des étapes manuelles initiales, et très limité sur iOS. La demande « sans devoir accepter manuellement chaque connexion » est atteignable pour les commandes musicales, mais pas pour la capture d'écran.

## 2. Contrôle et visualisation de l'écran

### Android

- **Capture d'écran** : API `MediaProjection`. Le système affiche une demande de consentement à l'utilisateur du téléphone distant. Depuis Android 14, le consentement porte sur une session de capture : il ne peut pas être réutilisé indéfiniment ni conservé silencieusement entre deux redémarrages de l'application. Un service de premier plan avec notification visible est obligatoire pendant la capture.
- **Contrôle tactile** : `AccessibilityService` avec `dispatchGesture`. L'utilisateur doit activer le service manuellement dans les réglages système. Android affiche des avertissements et, depuis Android 13, restreint l'activation des services d'accessibilité pour les applications installées hors du Play Store (« paramètres restreints », à débloquer manuellement dans les infos de l'application).
- **Contenu protégé** : les fenêtres marquées `FLAG_SECURE` (applications bancaires, certains lecteurs vidéo, écrans de mot de passe) apparaissent noires dans la capture. Cela ne se contourne pas.
- **Écran verrouillé** : la capture et les gestes sont limités quand l'appareil est verrouillé.
- **Publication Play Store** : une application qui capture l'écran et pilote l'appareil à distance est soumise à des règles strictes (usage de l'accessibilité, déclaration de service de premier plan). Distribution par APK auto-hébergé recommandée pour un usage personnel.

### iOS

- **Capture d'écran** : uniquement via ReplayKit avec une extension de diffusion (Broadcast Upload Extension). L'utilisateur doit lancer la diffusion lui-même depuis le sélecteur système ; l'application ne peut pas la démarrer seule à distance. L'extension a une limite mémoire stricte (de l'ordre de 50 Mo).
- **Contrôle tactile** : aucune API publique ne permet à une application d'injecter des touches dans le système ou dans d'autres applications. Le contrôle à distance de l'écran est donc impossible sur iOS sans contourner la sécurité du système, ce que le projet s'interdit.
- **Arrière-plan** : l'extension de diffusion peut continuer en arrière-plan, mais seulement tant que l'utilisateur ne l'arrête pas.

**Décision proposée** : Android = visualisation et contrôle via capture + accessibilité. iOS = pas de contrôle, visualisation optionnelle et manuelle en phase tardive (priorité basse).

## 3. Audio et Bluetooth

- **Lecture indépendante par téléphone** : chaque téléphone lit son propre flux avec son lecteur audio local. Deux téléphones peuvent donc jouer deux playlists différentes en même temps. Aucune contrainte de plateforme.
- **Détection de la sortie courante** :
  - Android : `AudioManager.getDevices()` et `AudioDeviceCallback` donnent le nom et le type (A2DP, casque, haut-parleur) du périphérique de sortie.
  - iOS : `AVAudioSession.currentRoute` donne la sortie courante en lecture seule.
- **Connexion et appairage Bluetooth** : l'appairage initial d'une enceinte ou d'un casque se fait dans les réglages système du téléphone distant. Le projet n'automatise pas l'appairage à distance.
- **Changer de sortie audio à distance** :
  - Android : le routage de sortie système n'est pas modifiable librement par une application tierce (restrictions depuis Android 10-12). Possible de façon partielle avec `MediaRouter` / `setPreferredDevice` pour son propre flux audio, ce qui doit être validé sur appareils réels. Le plan prévoit de l'afficher et de proposer ce changement uniquement si le test réel le confirme.
  - iOS : l'application ne peut pas imposer la sortie ; seul le sélecteur système (`AVRoutePickerView`) permet un choix manuel sur le téléphone. Non réalisable à distance.
- **Volume** : le volume du flux média peut être réglé par l'application sur Android (`AudioManager.setStreamVolume`). Sur iOS, le volume système ne se règle pas par programme ; le Controller pourra régler un gain interne du lecteur à la place.

## 4. Arrière-plan, reconnexion et commandes à distance

- **Android** : un service de premier plan de type média (`foregroundServiceType="mediaPlayback"`) avec `MediaSession` (Media3) garde la lecture active. Les optimisations de batterie des constructeurs (Doze, restrictions propres à certaines marques) peuvent tuer l'application : le client devra guider l'utilisateur pour désactiver l'optimisation de batterie.
- **iOS** : la lecture audio continue en arrière-plan avec la capacité « Audio, AirPlay and Picture in Picture ». En revanche, la WebSocket est suspendue peu après le passage en arrière-plan si aucun audio n'est en lecture. Pour réveiller un téléphone iOS, il faut des notifications push (APNs), à validation Apple et avec un compte développeur payant pour les mettre en œuvre.
- **Android réveil** : Firebase Cloud Messaging (FCM) est l'option standard. Alternative auto-hébergée : maintien de la WebSocket par le service de premier plan, ou UnifiedPush. À trancher à l'étape 2 du plan.
- **Reconnexion** : backoff exponentiel avec jitter, reprise de session par jeton d'appareil, resynchronisation de l'état complet à chaque reconnexion.

## 5. Navidrome et API Subsonic

- Navidrome expose l'API Subsonic (et des extensions OpenSubsonic). Points d'accès utiles : `ping`, `getArtists`, `getArtist`, `getAlbum`, `getAlbumList2`, `getPlaylists`, `getPlaylist`, `search3`, `getCoverArt`, `stream`, `download`, `getSong`.
- **Authentification Subsonic** : jeton `t = md5(mot_de_passe + sel)` avec sel `s`. MD5 est faible, mais c'est le mécanisme du protocole. Conséquence : les appareils ne doivent jamais détenir le mot de passe Navidrome réel.
- **Problème de sécurité structurant** : une URL de flux Subsonic contient les paramètres d'authentification dans la requête. Si l'URL fuit (journaux, historique), les identifiants fuient. Une URL de flux est donc traitée comme un secret à durée de vie courte.
- **Solution retenue** : un reverse proxy devant Navidrome vérifie un lien signé à durée limitée (HMAC, expiration, identifiant d'appareil, identifiant de morceau) émis par le serveur central. Navidrome n'est jamais exposé directement et les appareils ne reçoivent jamais de compte Navidrome. Le détail est dans `02-architecture.md`.
- **Compte Navidrome dédié** : le serveur central utilise un compte Navidrome non administrateur, avec les droits minimaux nécessaires à la lecture.

## 6. Réseau et accès à distance

| Option | Avantages | Contraintes |
|---|---|---|
| Reverse proxy public (Caddy ou Traefik, TLS Let's Encrypt) | Aucune installation sur les téléphones, simple pour l'utilisateur | Exposition Internet : durcissement, limitation de débit, surveillance indispensables |
| VPN mesh (Tailscale ou WireGuard) | Aucun port ouvert, chiffrement fort, Navidrome et serveur restent privés | Application VPN à installer et garder active sur chaque téléphone ; sur iOS un seul VPN actif à la fois |
| Combinaison : API publique derrière reverse proxy, Navidrome privé accessible par le serveur | Bon compromis | Le flux direct vers le téléphone suppose que Navidrome soit joignable par lui : voir relais optionnel |

**Recommandation** : reverse proxy avec TLS comme accès par défaut, VPN en option pour les utilisateurs qui veulent ne rien exposer. Le serveur de commandes et le proxy de flux sont séparés de Navidrome. Un relais audio optionnel (le serveur central relaie le flux) n'est activé que pour les appareils qui ne peuvent pas joindre le proxy de flux.

## 7. Risques majeurs et parades

| Risque | Gravité | Parade |
|---|---|---|
| Capture d'écran non autorisée d'un téléphone | Critique | Consentement système obligatoire, notification permanente, journal d'audit, permission distincte révocable |
| Vol de jeton d'appareil | Élevée | Jeton lié à une clé générée dans le Keystore / Secure Enclave, rotation, révocation immédiate |
| Fuite d'identifiants Navidrome | Élevée | Jamais envoyés aux appareils, liens signés à courte durée, compte dédié |
| Rejeu de commandes | Élevée | Nonce + horodatage + signature par message, numéro de séquence par appareil |
| Fermeture de l'application par le constructeur | Moyenne | Service de premier plan, consignes batterie, reconnexion automatique |
| Politique des stores | Moyenne | Distribution APK auto-hébergée pour Android, TestFlight ou compte développeur pour iOS |

## 8. Ce qui est volontairement exclu

- Aucun contournement des consentements système (capture d'écran, accessibilité).
- Aucun contrôle d'un appareil sans que son propriétaire ait installé l'application et accepté l'association.
- Aucune capture silencieuse ou cachée : le téléphone distant affiche toujours une indication visible quand son écran est partagé.

Le projet est conçu pour gérer **ses propres appareils** ou ceux d'utilisateurs consentants.
