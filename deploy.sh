#!/usr/bin/env bash
# Pipeline complet pour le cron : récupère les nouveaux rounds, régénère le site statique,
# et le pousse sur la branche gh-pages (GitHub Pages le sert automatiquement dès le push).
#
# Usage: ./deploy.sh [options de fetch_appariement.sh, ex. -r 10]
#   Variables d'env optionnelles :
#     GH_PAGES_BRANCH   branche de déploiement (défaut: gh-pages)
#     REMOTE            remote git à utiliser (défaut: origin)
#     SKIP_FETCH=1      ne pas relancer fetch_appariement.sh (juste rebuild + déploie)
#
# Ne fait rien (pas de commit ni de push) si le site généré est identique au dernier
# déploiement — normal la plupart du temps entre deux tours.

set -euo pipefail
cd "$(dirname "$0")"

GH_PAGES_BRANCH="${GH_PAGES_BRANCH:-gh-pages}"
REMOTE="${REMOTE:-origin}"

if [[ -z "${SKIP_FETCH:-}" ]]; then
  ./fetch_appariement.sh "$@"
fi

python3 build.py

if [[ -f site.cname ]]; then
  cp site.cname site/CNAME
fi

WORKTREE_DIR="$(mktemp -d)"
cleanup() { git worktree remove "$WORKTREE_DIR" --force >/dev/null 2>&1 || true; rm -rf "$WORKTREE_DIR"; }
trap cleanup EXIT

git fetch "$REMOTE" "$GH_PAGES_BRANCH" >/dev/null 2>&1 || true
if git show-ref --verify --quiet "refs/remotes/${REMOTE}/${GH_PAGES_BRANCH}"; then
  git worktree add "$WORKTREE_DIR" "$GH_PAGES_BRANCH" >/dev/null
else
  git worktree add "$WORKTREE_DIR" -b "$GH_PAGES_BRANCH" >/dev/null
fi

# Remplace tout le contenu de la branche de déploiement par le site fraîchement généré.
find "$WORKTREE_DIR" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -r site/. "$WORKTREE_DIR/"

cd "$WORKTREE_DIR"
git add -A
if git diff --cached --quiet; then
  echo "rien de nouveau à déployer" >&2
else
  git -c user.name="deploy-bot" -c user.email="deploy@localhost" \
    commit -q -m "Déploiement automatique — $(date -u '+%Y-%m-%d %H:%M UTC')"
  git push -q "$REMOTE" "$GH_PAGES_BRANCH"
  echo "déployé sur ${GH_PAGES_BRANCH}" >&2
fi
