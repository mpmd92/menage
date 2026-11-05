# Vie de couple

Tâches ménagères et listes de courses de Paul et Marguerite, partagées en ligne.

- **Page** : `index.html`, publiée avec GitHub Pages.
- **Données** : un Worker Cloudflare (`worker/`) garde la liste dans un Durable Object.
  Il conserve aussi les 200 versions précédentes (`GET /history`, `GET /history/<n>`), pour revenir en arrière après une erreur.
- **Accès** : protégé par un mot de passe. Le dépôt ne contient ni le mot de passe ni son empreinte :
  l'empreinte SHA-256 est le secret `PASSWORD_HASH` du Worker.

## Fonctionnement

Chaque personne a quatre sous-listes : hebdomadaire, mensuelle, tous les 3 mois, tous les ans.
Quand toutes les tâches d'une sous-liste sont cochées, elle se décoche et compte un cycle.
Chaque tâche garde la date de la dernière fois où elle a été faite, et sa durée.

L'onglet Courses a une sous-liste par magasin. Un article coché est supprimé une heure plus tard.

## Déployer le Worker

```bash
cd worker
npx wrangler deploy
npx wrangler secret put PASSWORD_HASH
```

La valeur de `PASSWORD_HASH` est l'empreinte SHA-256 du mot de passe, en hexadécimal.
Après un changement d'adresse du Worker, mettre à jour `API_URL` dans `index.html`.
