# Appariement — fetch + visualiseur

Deux morceaux : un script qui aspire les rounds d'appariement du CNG en CSV, et une
petite appli web locale qui les lit.

## 1. Récupérer les données

Mets tes identifiants dans `.cngrc` (copie `.cngrc.exemple`, remplis, `chmod 600`).
Deux modes au choix :

```bash
# Option A — connexion automatique (recommandé, marche en cron sans intervention)
cat > .cngrc <<'EOF'
CNG_EMAIL='ton.email@exemple.fr'
CNG_PASSWORD='ton-mot-de-passe'
EOF
chmod 600 .cngrc

# Option B — jeton manuel copié depuis les devtools (JWT ~20 min, à reprendre à chaque fois)
cat > .cngrc <<'EOF'
CNG_TOKEN='eyJ0eXAi...'
CNG_COOKIE='PHPSESSID=...; TS01dc4fc6=...'
EOF
chmod 600 .cngrc
```

Puis :

```bash
./fetch_appariement.sh              # tous les rounds, s'arrête après 2 vides
./fetch_appariement.sh -r 9         # un seul
./fetch_appariement.sh -r 1-12      # une plage
./fetch_appariement.sh -r 3,7,9 -f  # une liste, en forçant le refetch
```

| option | effet |
|---|---|
| `-r` | rounds : `9`, `1,2,3`, `1-12`, ou `all` (défaut) |
| `-p` | éléments par page (défaut 12000) |
| `-o` | dossier de sortie (défaut `./data`) |
| `-b` | ajoute un BOM UTF-8 pour Excel / LibreOffice |
| `-k` | garde les JSON bruts |
| `-f` | refetch même si le CSV existe |

Sortie, deux fichiers par round dans `data/` :

- `appariement_r<N>.csv` — une ligne par poste, rangs joints par `;`
- `appariement_r<N>_long.csv` — une ligne par rang attribué (pratique pour un tableur croisé)

Le script vérifie l'expiration du JWT avant de partir, saute les rounds déjà
téléchargés, et s'arrête proprement si le token meurt en cours de route (en mode
auto, il se reconnecte tout seul si besoin). Pour un cron, exemple :

```cron
0 9,15 * * * cd /chemin/vers/appariement-viewer && ./fetch_appariement.sh >> fetch.log 2>&1
```

## 2. Générer et lancer le visualiseur

Site 100% statique : `build.py` transforme les CSV en un seul `data.json`, tout le
calcul (filtres, statuts, marge, stats) tourne ensuite dans le navigateur. Pas de
serveur applicatif, pas de dépendance à installer.

```bash
./run.sh                    # build + sert sur :8000
./run.sh -p 8080 -d ./data  # port et dossier de données au choix
```

Puis <http://127.0.0.1:8000>.

Relance `./run.sh` (ou juste `python3 build.py`) après chaque nouveau fetch pour que
les données se mettent à jour — contrairement à l'ancienne version Flask, rien ne se
recharge tout seul, il faut régénérer `data.json`.

Pour déployer ailleurs (Netlify, GitHub Pages, Cloudflare Pages...), génère le site
avec `python3 build.py` et dépose le contenu du dossier `site/` tel quel — ce sont
des fichiers statiques, n'importe quel hébergeur de fichiers convient. Si tu veux
protéger l'accès par mot de passe, ça se configure côté hébergeur (ex. protection
par mot de passe Netlify, Cloudflare Access), pas dans le code.

### Vue « Postes »

Tu tapes ton rang, tu coches les villes et les spécialités, et chaque poste du tour
sélectionné se range dans une catégorie :

- **libre** — il reste des places non pourvues, ton rang n'entre pas en jeu
- **accessible** — ton rang est meilleur que le dernier rang pris sur ce poste
- **limite** — tu dépasses le dernier rang pris, mais de moins que la marge réglée à gauche
- **hors d'atteinte** — au-delà

La colonne « Fenêtre de rangs » place la barre du premier au dernier rang pris, avec un
repère à ta position : tu vois d'un coup d'œil si tu tombes dedans, avant, ou après.
Les en-têtes de colonnes trient.

### Vue « Évolution »

Mêmes filtres, mais tracés sur tous les tours chargés. Tu choisis la mesure (classement
avec médiane/quartiles/min-max, postes accessibles à ton rang, places restantes…) et si
tu veux une courbe par ville, par spécialité, par poste, par groupe, ou une seule pour
toute la sélection. Clic sur une entrée de légende pour masquer sa courbe.

Le rang, les cases cochées et la marge sont conservés dans le navigateur d'un lancement
à l'autre.

## À savoir sur l'interprétation

« Accessible » compare ton rang au **dernier rang effectivement pris** sur ce poste lors
d'un round déjà joué. C'est un indicateur du passé, pas une garantie : à round égal les
seuils bougent selon qui choisit quoi avant toi. Les postes marqués *libre* sont les seuls
réellement ouverts au moment de l'extraction.

Le champ `id` renvoyé par l'API vaut toujours le `roundId`, il n'identifie pas le poste —
c'est pour ça qu'il n'est pas dans les CSV. La clé utile est le couple spécialité + ville.

## Dépendances

`curl` et `jq` pour le script de fetch. Python 3.10+ (lib standard uniquement, aucun
`pip install`) pour générer et servir le site. Aucun CDN, aucune ressource externe :
ça tourne hors ligne.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE) — libre pour tout usage non commercial (usage
personnel, associatif, éducatif, recherche...). Usage commercial soumis à accord préalable
avec l'auteur (typiquement une rémunération) — voir le contact ci-dessous.

## Contact

externe.aigri@lanpinet.fr (oui, cette adresse est réelle malgré les apparences)

PS1 : je débarque à Toulouse, envoie-moi un mail si tu veux bien être mon ami, allez s'il te plaît.
PS2 : toujours célibataire. `pacman -S copine` renvoie "target not found" à chaque
fois — si tu tournes sous Linux, tente ta chance.
