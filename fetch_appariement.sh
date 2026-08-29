#!/usr/bin/env bash
# Récupère les postes d'un ou plusieurs rounds d'appariement (galien.cngsante.fr)
# et exporte un CSV par round.
#
# Usage: ./fetch_appariement.sh [-r ROUNDS] [-p PER_PAGE] [-o DIR] [-b] [-k] [-f]
#   -r  rounds: "9", "1,2,3", "1-12", ou "all" (sonde à partir de PROBE_START,
#       jusqu'au premier vide durable). défaut: all
#   -p  éléments par page (défaut 12000)
#   -o  dossier de sortie (défaut ./data)
#   -b  ajoute un BOM UTF-8 (Excel / LibreOffice)
#   -k  garde les JSON bruts
#   -f  refetch même si le CSV existe déjà
#
# Identifiants — deux modes, au choix dans ./.cngrc (voir .cngrc.exemple) :
#   auto   : CNG_EMAIL + CNG_PASSWORD  -> connexion automatique à chaque lancement,
#            adapté à un cron (aucune intervention manuelle).
#   manuel : CNG_TOKEN + CNG_COOKIE    -> jeton/cookie copiés depuis les devtools
#            du navigateur (JWT valide ~20 min, à reprendre à chaque fois).

set -euo pipefail
cd "$(dirname "$0")"

ROUNDS_SPEC="all"
PERPAGE=12000
OUTDIR="./data"
BOM=0
KEEP=0
FORCE=0
MAX_PROBE=40          # garde-fou pour "all"
EMPTY_STREAK_STOP=2   # nb de rounds vides consécutifs avant d'arrêter
# Les rounds 1-5 appartiennent à une phase antérieure hors sujet pour cette campagne
# (voir HIDDEN_ROUNDS dans build.py, qui les masque aussi côté affichage) — inutile de
# les sonder à chaque "all". À AJUSTER si une prochaine campagne recommence à 1.
PROBE_START=6
COOKIE_JAR="$(mktemp -t cng-cookies.XXXXXX)"
trap 'rm -f "$COOKIE_JAR"' EXIT

while getopts "r:p:o:bkfh" opt; do
  case "$opt" in
    r) ROUNDS_SPEC=$OPTARG ;;
    p) PERPAGE=$OPTARG ;;
    o) OUTDIR=$OPTARG ;;
    b) BOM=1 ;;
    k) KEEP=1 ;;
    f) FORCE=1 ;;
    h) sed -n '2,16p' "$0"; exit 0 ;;
    *) exit 2 ;;
  esac
done

for bin in curl jq; do
  command -v "$bin" >/dev/null || { echo "manque: $bin" >&2; exit 1; }
done

# shellcheck source=/dev/null
[[ -f ./.cngrc ]] && source ./.cngrc

AUTH_MODE="manuel"
if [[ -n "${CNG_EMAIL:-}" && -n "${CNG_PASSWORD:-}" ]]; then
  AUTH_MODE="auto"
else
  : "${CNG_TOKEN:?CNG_TOKEN non défini (JWT ~20 min, à reprendre dans les devtools — ou définis CNG_EMAIL/CNG_PASSWORD pour la connexion automatique)}"
  : "${CNG_COOKIE:?CNG_COOKIE non défini (PHPSESSID=...; TS01...=...)}"
fi

mkdir -p "$OUTDIR"

# --- connexion automatique (mode "auto") ------------------------------------
# Le mot de passe part uniquement dans le corps JSON de cette requête HTTPS ; il
# n'apparaît jamais dans un log ou une trace shell (pas de `set -x` dans ce script).
login() {
  echo "connexion (CNG_EMAIL)..." >&2
  local payload resp
  payload=$(jq -n --arg u "$CNG_EMAIL" --arg p "$CNG_PASSWORD" '{username:$u, password:$p}')
  resp=$(curl -sS -c "$COOKIE_JAR" \
    --url 'https://www.galien.cngsante.fr/api/auth/login' \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/plain, */*' \
    -H 'Referer: https://www.galien.cngsante.fr/sign-in' \
    -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0' \
    --data-raw "$payload")
  if [[ "$(jq -r '.login // empty' <<<"$resp" 2>/dev/null)" != "success" ]]; then
    echo "échec de connexion — vérifie CNG_EMAIL/CNG_PASSWORD dans .cngrc." >&2
    echo "(si le compte a la double authentification active, l'auto-login peut ne pas suffire :" >&2
    echo " repasse en mode manuel avec CNG_TOKEN/CNG_COOKIE le temps de vérifier.)" >&2
    exit 1
  fi
  CNG_TOKEN=$(jq -r '.token' <<<"$resp")
  echo "connecté." >&2
}

if [[ $AUTH_MODE == auto ]]; then
  login
fi

# --- contrôle d'expiration du JWT ------------------------------------------
exp=$(cut -d. -f2 <<<"$CNG_TOKEN" \
  | tr '_-' '/+' | awk '{ while (length($0)%4) $0=$0"="; print }' \
  | base64 -d 2>/dev/null | jq -r '.exp // empty' 2>/dev/null || true)
now=$(date +%s)
if [[ -n $exp ]]; then
  if (( exp <= now )); then
    echo "JWT expiré depuis $(( (now-exp)/60 )) min — reprends-en un." >&2
    exit 1
  fi
  echo "JWT valide encore $(( (exp-now)/60 ))m$(( (exp-now)%60 ))s." >&2
fi
jwt_alive() {
  [[ -z $exp ]] && return 0
  (( exp > $(date +%s) + 5 )) && return 0
  [[ $AUTH_MODE == auto ]] || return 1
  login   # re-connexion silencieuse au lieu d'échouer, seulement possible en mode auto
  exp=$(cut -d. -f2 <<<"$CNG_TOKEN" | tr '_-' '/+' \
    | awk '{ while (length($0)%4) $0=$0"="; print }' | base64 -d 2>/dev/null | jq -r '.exp // empty')
}

# --- expansion de la spec de rounds ----------------------------------------
expand_rounds() {
  local spec=$1 part
  IFS=',' read -ra parts <<<"$spec"
  for part in "${parts[@]}"; do
    if [[ $part =~ ^([0-9]+)-([0-9]+)$ ]]; then
      seq "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    elif [[ $part =~ ^[0-9]+$ ]]; then
      echo "$part"
    else
      echo "spec de round invalide: $part" >&2; exit 2
    fi
  done
}

# --- récupération d'un round ------------------------------------------------
# renvoie 0 si des données ont été écrites, 1 si round vide, 2 si erreur HTTP
fetch_round() {
  local round=$1 json=$2
  local url="https://www.galien.cngsante.fr/appariement/api/round_posts?roundId=${round}&page=1&perPage=${PERPAGE}"
  local code
  local -a cookie_opt
  if [[ $AUTH_MODE == auto ]]; then
    cookie_opt=(-b "$COOKIE_JAR")   # cookies posés par /api/auth/login, renvoyés tels quels
  else
    cookie_opt=(-H "Cookie: ${CNG_COOKIE}")
  fi
  code=$(curl -sS --compressed -w '%{http_code}' -o "$json" "$url" \
    -H 'Accept: application/json, text/plain, */*' \
    -H "Authorization: Bearer ${CNG_TOKEN}" \
    "${cookie_opt[@]}" \
    -H 'Referer: https://www.galien.cngsante.fr/appariement/candidates/positions' \
    -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0')

  if [[ $code == 401 || $code == 403 ]]; then
    echo "  HTTP $code — token ou cookie invalide/expiré." >&2; return 2
  fi
  if [[ $code == 404 ]]; then return 1; fi
  if [[ $code != 200 ]]; then
    echo "  HTTP $code" >&2; head -c 300 "$json" >&2; echo >&2; return 2
  fi
  jq -e '.roundPostDTOs | type == "array"' "$json" >/dev/null 2>&1 || {
    echo "  réponse inattendue" >&2; return 2; }
  local got total
  got=$(jq -r '.roundPostDTOs | length' "$json")
  (( got == 0 )) && return 1
  total=$(jq -r '.totalItems // empty' "$json")
  echo "  ${got}${total:+/$total} postes" >&2
  if [[ -n $total ]] && (( got < total )); then
    echo "  ATTENTION: tronqué, augmente -p" >&2
  fi
  return 0
}

# --- écriture des CSV -------------------------------------------------------
write_csv() {
  local round=$1 json=$2
  local wide="${OUTDIR}/appariement_r${round}.csv"
  local long="${OUTDIR}/appariement_r${round}_long.csv"

  jq -r --arg round "$round" '
    ["round","gds","specialite","subdivision","places","restantes","attribuees",
     "rang_min","rang_max","nb_rangs","rangs"],
    (.roundPostDTOs[] | [
       ($round|tonumber), .gds, .speciality, .subdivision,
       .numberOfPlaces, .numberOfPlaceRemaining, .numberOfPlaceAssigned,
       (.limitRanks[0] // null), (.limitRanks[1] // null),
       (.ranks | length),
       (.ranks | map(tostring) | join(";"))
    ]) | @csv
  ' "$json" > "$wide"

  jq -r --arg round "$round" '
    ["round","gds","specialite","subdivision","places","rang"],
    (.roundPostDTOs[] as $p | $p.ranks[] |
       [($round|tonumber), $p.gds, $p.speciality, $p.subdivision,
        $p.numberOfPlaces, .]) | @csv
  ' "$json" > "$long"

  if (( BOM )); then
    for f in "$wide" "$long"; do
      printf '\xEF\xBB\xBF' | cat - "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    done
  fi
  echo "  → $wide" >&2
}

# --- boucle principale ------------------------------------------------------
written=0
empty_streak=0
found_data=0   # devient 1 dès qu'un round non vide a été vu (présent ou fraîchement récupéré)

run_one() {
  local round=$1 json rc
  local wide="${OUTDIR}/appariement_r${round}.csv"

  if (( ! FORCE )) && [[ -s $wide ]]; then
    echo "round ${round}: déjà présent (-f pour refetch)" >&2
    empty_streak=0
    found_data=1
    return 0
  fi
  jwt_alive || { echo "JWT expiré en cours de route — relance avec un token frais." >&2; exit 1; }

  echo "round ${round}:" >&2
  json=$(mktemp "${OUTDIR}/.r${round}.XXXX.json")
  set +e; fetch_round "$round" "$json"; rc=$?; set -e

  case $rc in
    0) write_csv "$round" "$json"; written=$((written+1)); empty_streak=0; found_data=1 ;;
    1) echo "  vide" >&2; empty_streak=$((empty_streak+1)) ;;
    2) rm -f "$json"; exit 1 ;;
  esac

  if (( KEEP )); then
    mv "$json" "${OUTDIR}/round_${round}.json"
  else
    rm -f "$json"
  fi
  sleep 0.3   # on ne martèle pas le serveur
}

if [[ $ROUNDS_SPEC == "all" ]]; then
  # Ne pas confondre "pas encore commencé" et "terminé" : tant qu'aucun round n'a jamais
  # rendu de données, une série de rounds vides en tête (ex. anciens rounds 1-5 devenus
  # inaccessibles sur une relance à froid) ne doit PAS stopper la sonde avant d'avoir
  # atteint les rounds réels plus loin. Une fois qu'on a vu au moins un round non vide,
  # le garde-fou habituel (2 vides d'affilée = fin de la campagne) reprend la main.
  for r in $(seq "$PROBE_START" "$MAX_PROBE"); do
    run_one "$r"
    if (( found_data )) && (( empty_streak >= EMPTY_STREAK_STOP )); then
      echo "arrêt: $empty_streak rounds vides." >&2
      break
    fi
  done
else
  while read -r r; do run_one "$r"; done < <(expand_rounds "$ROUNDS_SPEC")
fi

echo "${written} round(s) écrit(s) dans ${OUTDIR}/" >&2
ls -1 "${OUTDIR}"/appariement_r*.csv 2>/dev/null | grep -v '_long' || true
