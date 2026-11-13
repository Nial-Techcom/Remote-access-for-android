# Installation — version 0.1.0 (serveur)

**Composants livrés :** serveur central (`nial-control-server-0.1.0.tar.gz`). Pas d'application mobile dans cette version.

**Procédure :** suivre [`INSTALLATION.md`](../../../INSTALLATION.md) avec `VERSION=0.1.0`.

## Spécifique à cette version

| Point | Valeur |
|---|---|
| Node.js | 22.23.4 (installé par le script dans `/opt/nial-control/node`) |
| Version du schéma de base | 1 |
| Version du protocole temps réel | 1 |
| Migration depuis une autre version | Aucune (première version) |
| Compatibilité des applications | Applications à venir : protocole 1 |

## Vérification après installation

```bash
curl -s http://127.0.0.1:8080/api/health                       # {"status":"ok"}
# avec un compte administrateur :
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/api/auth/login -H 'content-type: application/json' \
  -d '{"identifier":"<admin>","password":"<mot de passe>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/status   # "navidrome": true attendu
```

## Limites connues de cette version

- Aucune interface web : l'administration se fait par l'API et la ligne de commande (`dist/cli.js`).
- La réinitialisation de mot de passe passe par un jeton émis par un administrateur (pas d'envoi d'e-mail).
- Les empreintes SHA-256 des morceaux sont calculées à la première demande de téléchargement (lecture complète du fichier une fois) : l'envoi d'une très grande playlist en mode téléchargement peut prendre plusieurs minutes la première fois.
- Testé avec un faux serveur Navidrome ; à valider sur votre instance réelle (voir la liste de contrôle du rapport d'audit).
