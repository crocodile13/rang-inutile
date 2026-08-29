#!/usr/bin/env python3
"""Génère le site statique (site/ par défaut) à partir des CSV — relance-le après chaque
fetch_appariement.sh pour que les nouvelles données apparaissent.

Aucune dépendance externe (que la lib standard) : pas besoin de venv ni de pip install.
Le site généré est entièrement statique — un simple bloc JSON + HTML/CSS/JS — servable
par n'importe quel hébergeur de fichiers statiques ou même `python3 -m http.server`.
"""

import argparse
import csv
import glob
import json
import os
import re
import shutil
from dataclasses import dataclass, field

DATA_DIR_DEFAULT = os.environ.get("APPARIEMENT_DATA", "data")
FILE_RE = re.compile(r"appariement_r(\d+)\.csv$")

# Étiquettes lisibles pour les rounds bruts de l'API CNG. La numérotation CNG est continue à
# travers les phases (round 6, 7, 8...), alors qu'EVEN redémarre à "Tour 1" à chaque phase — les
# deux ne coïncident pas. Rounds 1-5 : phase antérieure non pertinente pour cette campagne, on
# les masque entièrement. À METTRE À JOUR quand une nouvelle phase démarre (Tours à Blanc,
# Phase Définitive) : ajoute les rounds correspondants ici.
HIDDEN_ROUNDS = {1, 2, 3, 4, 5}
ROUND_LABELS = {
    6: "Simulation — Tour 1",
    7: "Simulation — Tour 2",
    8: "Simulation — Tour 3",
    9: "Simulation — Tour 4",
}


def round_label(n: int) -> str:
    return ROUND_LABELS.get(n, f"Tour {n} (à étiqueter)")


@dataclass
class Post:
    round: int
    gds: str
    specialite: str
    subdivision: str
    places: int
    restantes: int
    attribuees: int
    rang_min: int | None
    rang_max: int | None
    rangs: list[int] = field(default_factory=list)


def _int(value, default=0):
    value = (value or "").strip()
    if not value:
        return default
    try:
        return int(float(value))
    except ValueError:
        return default


def _opt_int(value):
    return _int(value, default=None)


def load_dir(data_dir: str) -> dict[int, list[Post]]:
    """Lit tous les appariement_r<N>.csv d'un dossier. Le _long est ignoré, et les rounds
    masqués (HIDDEN_ROUNDS) ne sont même pas chargés."""
    rounds: dict[int, list[Post]] = {}
    for path in sorted(glob.glob(os.path.join(data_dir, "appariement_r*.csv"))):
        match = FILE_RE.search(os.path.basename(path))
        if not match:
            continue  # écarte les *_long.csv
        rnd = int(match.group(1))
        if rnd in HIDDEN_ROUNDS:
            continue
        posts = []
        with open(path, newline="", encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                rangs = [int(x) for x in (row.get("rangs") or "").split(";") if x.strip()]
                posts.append(
                    Post(
                        round=_int(row.get("round"), rnd),
                        gds=(row.get("gds") or "").strip(),
                        specialite=(row.get("specialite") or "").strip(),
                        subdivision=(row.get("subdivision") or "").strip(),
                        places=_int(row.get("places")),
                        restantes=_int(row.get("restantes")),
                        attribuees=_int(row.get("attribuees")),
                        rang_min=_opt_int(row.get("rang_min")),
                        rang_max=_opt_int(row.get("rang_max")),
                        rangs=rangs,
                    )
                )
        if posts:
            rounds[rnd] = posts
    return rounds


def build_bulk(rounds: dict[int, list[Post]]) -> dict:
    """Même forme que l'ancien /api/bulk : un bloc JSON unique, sans la liste brute des rangs
    individuels (seul le compte `nb_rangs` sert côté client)."""
    posts = [
        {
            "round": post.round,
            "gds": post.gds,
            "specialite": post.specialite,
            "subdivision": post.subdivision,
            "places": post.places,
            "restantes": post.restantes,
            "attribuees": post.attribuees,
            "rang_min": post.rang_min,
            "rang_max": post.rang_max,
            "nb_rangs": len(post.rangs),
        }
        for r in sorted(rounds)
        for post in rounds[r]
    ]
    return {
        "rounds": sorted(rounds),
        "round_labels": {str(r): round_label(r) for r in sorted(rounds)},
        "subdivisions": sorted({p["subdivision"] for p in posts if p["subdivision"]}),
        "specialites": sorted({p["specialite"] for p in posts if p["specialite"]}),
        "gds": sorted({p["gds"] for p in posts if p["gds"]}),
        "posts": posts,
    }


def build(data_dir: str, out_dir: str) -> None:
    rounds = load_dir(data_dir)
    if not rounds:
        print(f"aucun CSV exploitable dans {os.path.abspath(data_dir)} — lance fetch_appariement.sh d'abord")

    bulk = build_bulk(rounds)

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "data.json"), "w", encoding="utf-8") as f:
        json.dump(bulk, f, ensure_ascii=False, separators=(",", ":"))

    shutil.copy("templates/index.html", os.path.join(out_dir, "index.html"))
    dest_static = os.path.join(out_dir, "static")
    if os.path.isdir(dest_static):
        shutil.rmtree(dest_static)
    shutil.copytree("static", dest_static)

    n_posts = len(bulk["posts"])
    print(f"site généré dans {out_dir}/ — {len(rounds)} tour(s) visible(s), {n_posts} postes.")


def main():
    parser = argparse.ArgumentParser(description="Génère le site statique de l'appariement")
    parser.add_argument("-d", "--data", default=DATA_DIR_DEFAULT, help="dossier des CSV (défaut: data)")
    parser.add_argument("-o", "--out", default="site", help="dossier de sortie (défaut: site)")
    opts = parser.parse_args()
    build(opts.data, opts.out)


if __name__ == "__main__":
    main()
