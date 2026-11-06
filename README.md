# finals-hq-data

Collecteur de snapshots des classements publics de **THE FINALS**, pour le projet FINALS HQ.
Toutes les 15 minutes, un job GitHub Actions lit l'API communautaire
[the-finals-leaderboard.com](https://api.the-finals-leaderboard.com) (projet open source
[leonlarsson/the-finals-api](https://github.com/leonlarsson/the-finals-api)) et enregistre ici ce qui a changé.

> Projet de fan, non affilié à Embark Studios. Les données proviennent des classements publics
> publiés par Embark et normalisés par l'API communautaire citée ci-dessus. Un joueur qui souhaite ne plus
> apparaître dans les produits dérivés de ces données peut le demander (procédure à venir dans FINALS HQ).

*English: unofficial snapshot collector for THE FINALS public leaderboards, used by FINALS HQ. Not affiliated with Embark Studios.*

## Pourquoi

L'API ne donne qu'un instantané : pas d'historique, pas de stats par match. L'historique se construit donc
en prenant des instantanés réguliers. Chaque jour sans collecte est perdu pour toujours, d'où ce dépôt
lancé avant même l'application.

## Ce qui est enregistré

Les lignes sont stockées **telles que l'API les renvoie** (aucun renommage, aucune valeur dérivée) :
le collecteur conserve des preuves, il n'interprète pas.

```
state/<clé>/manifest.json           état courant (petit, réécrit à chaque run)
state/<clé>/full-<horodatage>.json.gz   snapshot complet de référence
state/<clé>/delta-<horodatage>.json.gz  changements depuis le snapshot précédent de la chaîne
archive/<clé>/AAAA/MM/JJ/…          anciennes chaînes, déplacées telles quelles
seasons/<clé>/full-<horodatage>.json.gz  classements figés (saisons passées, événements), téléchargés une fois
runs.log                             une ligne JSON par classement et par run
errors/                              corps de réponse qui ont échoué la validation
```

`<clé>` = `<id>-<plateforme>` (ex. `s12-crossplay`) ou `<id>` seul.

- **Snapshot complet** : toutes les lignes (10 000 par classement, ~500 Ko en gzip), pris au premier run,
  puis toutes les `fullEveryMinutes` minutes (24 h par défaut), ou quand plus de 60 % des lignes ont changé.
- **Delta** : les lignes nouvelles en entier, et pour les lignes dont un champ *non volatil* a changé, seulement
  l'id et les champs qui diffèrent (un joueur qui a gagné du Rank Score coûte 5 champs, pas 12), plus les ids disparus.
  Les champs volatils (`rank`, `change`) ne déclenchent pas d'écriture : un joueur qui ne joue pas voit son rang
  bouger à cause des autres, et son rang exact se retrouve dans le snapshot complet suivant ou se recalcule
  à partir des scores.
- **Inchangé** : réponse identique octet pour octet à la précédente (hash SHA-256) → une ligne dans `runs.log`, aucun fichier.
- Chaque fichier contient l'URL appelée, l'heure, les en-têtes de cache de la réponse et le hash du corps.

Reconstruire l'état à un instant t : lire le `full` de la chaîne, puis appliquer les `delta` dans l'ordre
(`src/delta.ts` → `applyDelta`, qui fusionne les lignes partielles dans l'état précédent).

## Ce qui est suivi (saison 12, vérifié le 5 novembre 2026)

| Classement | Cadence | Champs (vérifiés sur une réponse réelle) |
|---|---|---|
| `s12` (Ranked Cashout) | toutes les 10 min | `rank, change, name, steamName, psnName, xboxName, clubTag, clubUuid, officialClubName, leagueNumber, league, rankScore` |
| `s12worldtour`, `s12sponsor` | toutes les heures | même base, score en `cashouts` ou `sponsor` + `fans`, sans `change`/`league` |
| `s12powershift`, `s12quickcash`, `s12teamdeathmatch`, `s12pointbreak`, `s12soloshowdown` | toutes les 6 h | même base, score en `points` |

Faits utiles sur la source (observés) : réponse `{ meta, count, data }`, 10 000 entrées maximum, plateforme
`crossplay` obligatoire en S12, cache HTTP de 10 min et cache interne de 10 à 20 min (une donnée peut avoir
~30 min de retard sur Embark), aucun en-tête de limite de débit, CORS ouvert. Les saisons passées sont figées
et seront importées une seule fois par l'application.

Volume attendu : environ 10 Mo par jour tout compris. Ce dépôt git est le stockage de départ (0 €, zéro compte
supplémentaire) ; les fichiers seront migrés vers un stockage objet ou une base de données quand l'application
existera, sans perte puisque chaque fichier est autonome.

## Configuration

`config/leaderboards.json` liste les classements suivis. Un classement n'y entre qu'après vérification
manuelle de son id, de sa plateforme et de son schéma (voir le dossier de vérification du projet FINALS HQ).

| Champ | Rôle |
|---|---|
| `id`, `platform`, `kind` | segment d'URL : `/v1/leaderboard/<id>/<platform>` ou `/v1/community-event/<id>` |
| `idField` | champ qui identifie une ligne d'un run à l'autre (défaut : `name`) |
| `volatileFields` | champs ignorés pour détecter un changement |
| `fullEveryMinutes` | âge maximal d'un snapshot complet avant d'en reprendre un |
| `everyMinutes` | cadence propre au classement (0 = à chaque run du job) |

## Archives (classements figés)

`config/archives.json` liste les 85 classements figés (saisons cb1 à s11, plateformes séparées de ob/s1/s2,
classements spéciaux, événements communautaires). Le workflow `import-archives` (lancement manuel) exécute
`src/import-archives.ts`, qui télécharge chaque classement absent de `seasons/` une seule fois, au même format
qu'un snapshot complet, et le commite. L'application les importe ensuite dans sa table `season_results`.

## Réveil de l'application

Après chaque commit, le workflow `collect` envoie un `repository_dispatch` (`data-updated`) au dépôt
[finals-hq-](https://github.com/gojoziaa-debug/finals-hq-) si le secret `DISPATCH_TOKEN` existe ici : un token à
grain fin limité à ce dépôt-là avec la permission *Contents: read and write*. Sans ce secret, l'application se
contente de son propre cron.

## Lancer en local

```bash
npm test                                   # tests unitaires + bout en bout (Node ≥ 22.6, aucune dépendance)
npm run collect                            # un run réel, écrit dans ./state
npm run import-archives -- --only s11-crossplay   # télécharge un classement figé dans ./seasons
node --experimental-strip-types src/collect.ts --root /tmp/essai --only s12-crossplay
```

## Politesse envers la source

Une requête par classement et par run (au plus 8 requêtes par 10 min, souvent 1), 2 s entre deux requêtes,
délai d'attente de 30 s, 2 nouvelles tentatives au plus (429 et 5xx, en respectant `Retry-After`), User-Agent
identifiable. Si le schéma change, le run échoue et le corps brut est conservé dans `errors/` : rien n'est deviné.

## Points de vigilance

- GitHub désactive les workflows planifiés après 60 jours sans activité sur le dépôt ; les commits du collecteur
  comptent comme activité, mais à surveiller.
- Les crons GitHub peuvent être retardés de plusieurs minutes aux heures de pointe ; `runs.log` donne l'heure réelle.
- Le job échoue (et GitHub prévient le propriétaire par e-mail) dès qu'un classement n'est pas collectable ;
  les autres classements du même run sont quand même enregistrés.
