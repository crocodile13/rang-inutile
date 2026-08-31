"use strict";

/* Tout le calcul (filtres, statuts, marge, groupements, stats) tourne ici, côté client, sur un
 * seul bloc de données chargé une fois au démarrage (data.json, généré par build.py). Site
 * entièrement statique — aucun serveur applicatif, juste des fichiers. */

const STORE = "appariement.state.v1";
const state = {
  round: null,
  margin: 150,
  autoMargin: false,
  marginK: 1,
  subdivision: new Set(),
  specialite: new Set(),
  statusFilter: new Set(),
  showAllVilles: false,
  showAllSpecialites: false,
  metric: "classement",
  group: "none",
  viewMode: "cumule", // "cumule" (total) ou "individuel" (médiane/quartiles/min-max par poste)
  sort: { key: "rang_max", dir: -1 },
  hidden: new Set(),
  wishlist: [],
};

let meta = { rounds: [], round_labels: {}, subdivisions: [], specialites: [], gds: [] };
let ALL_POSTS = [];
let byRound = new Map();
let rankHistory = new Map();
let lastPosts = [];
let lastCeiling = 0;
let villesBySpecialite = new Map();
let specialitesByVille = new Map();

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (n === null || n === undefined ? "—" : n.toLocaleString("fr-FR"));

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------------------ état -- */

function save() {
  try {
    localStorage.setItem(
      STORE,
      JSON.stringify({
        ...state,
        subdivision: [...state.subdivision],
        specialite: [...state.specialite],
        hidden: [...state.hidden],
        statusFilter: [...state.statusFilter],
      })
    );
  } catch (e) {
    /* mode privé, on continue sans persistance */
  }
}

function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "{}");
    Object.assign(state, raw, {
      subdivision: new Set(raw.subdivision || []),
      specialite: new Set(raw.specialite || []),
      hidden: new Set(raw.hidden || []),
      statusFilter: new Set(raw.statusFilter || []),
      sort: raw.sort || state.sort,
    });
  } catch (e) {
    /* état illisible: on repart des valeurs par défaut */
  }
}

let timer = null;
function refresh() {
  save();
  clearTimeout(timer);
  timer = setTimeout(() => {
    if ($("#view-table").hidden) renderChart();
    else renderPosts();
  }, 60);
}

function showError(message) {
  const banner = $("#errorBanner");
  if (!message) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.textContent = message;
}

async function fetchJSON(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error("Connexion au serveur impossible.");
  }
  if (!res.ok) throw new Error(`Le serveur a répondu ${res.status}.`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error("Réponse du serveur illisible.");
  }
}

/* ------------------------------------------------------------- tours -- */

function roundLabel(r) {
  return meta.round_labels[r] ?? `Tour ${r}`;
}

function roundShortLabel(r) {
  const full = roundLabel(r);
  const parts = full.split("—");
  return (parts[1] || parts[0]).trim();
}

/* -------------------------------------------------------- logique métier -- */
/* Port direct de ce qui tournait côté serveur (Flask, app.py) avant de passer au tout-statique. */

const OPEN_STATUSES = new Set(["libre", "accessible"]);

function statusOf(post, rank, margin) {
  if (post.restantes > 0 || post.rang_max === null) return "libre";
  if (rank === null) return "pourvu";
  if (rank <= post.rang_max) return "accessible";
  if (rank <= post.rang_max + margin) return "limite";
  return "pris";
}

function matchesFilters(post, subdivisions, specialites, gds) {
  if (subdivisions.size && !subdivisions.has(post.subdivision)) return false;
  if (specialites.size && !specialites.has(post.specialite)) return false;
  if (gds.size && !gds.has(post.gds)) return false;
  return true;
}

function posteKey(post) {
  // Séparateur explicite (imprimable) entre spécialité et ville : sans lui, deux couples
  // (spécialité, ville) différents pourraient produire la même clé par concaténation
  // (ex. "Chirurgie A"+"BC" == "Chirurgie AB"+"C"), mélangeant silencieusement leurs
  // historiques de rang dans la marge statistique.
  return post.specialite + "\u241F" + post.subdivision;
}

function median(sortedArr) {
  const n = sortedArr.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedArr[mid] : (sortedArr[mid - 1] + sortedArr[mid]) / 2;
}

function quantile(sortedArr, p) {
  const idx = p * (sortedArr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

function rankStats(limits) {
  if (!limits.length) return null;
  const sorted = [...limits].sort((a, b) => a - b);
  const n = sorted.length;
  const med = median(sorted);
  const q1 = n >= 2 ? quantile(sorted, 0.25) : med;
  const q3 = n >= 2 ? quantile(sorted, 0.75) : med;
  return { min: sorted[0], q1, median: med, q3, max: sorted[n - 1], n };
}

function sampleStdev(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

function buildRankHistory(rounds) {
  const history = new Map();
  for (const r of rounds) {
    for (const post of byRound.get(r) || []) {
      if (post.rang_max === null) continue;
      const key = posteKey(post);
      if (!history.has(key)) history.set(key, []);
      history.get(key).push(post.rang_max);
    }
  }
  return history;
}

function positionnementFor(gds) {
  // Un "positionnement" (guide CNG, section "Mes positionnements") est le classement du
  // candidat CALCULÉ SÉPARÉMENT POUR CHAQUE groupe de spécialités par l'algorithme
  // d'appariement (Gale-Shapley) — pas un ordre de préférence. Le champ "code" de
  // state.wishlist porte cette valeur (voir wireWishlist / le renommage d'affichage
  // "Classement"). Source : guide d'utilisation officiel du CNG, page 7-8.
  const w = state.wishlist.find((w) => w.label === gds);
  return w ? Number(w.code) : null;
}

function effectiveRank(post) {
  // Pas de rang global de repli : le classement n'existe que par groupe de spécialités
  // (voir positionnementFor) — un poste dont le groupe n'a pas été renseigné reste "pourvu"
  // faute de valeur à comparer, plutôt que de comparer à un chiffre qui n'a pas de sens ici.
  const p = positionnementFor(post.gds);
  return p !== null && Number.isFinite(p) ? p : null;
}

function effectiveMargin(post) {
  if (!state.autoMargin) return state.margin;
  const values = rankHistory.get(posteKey(post));
  if (!values || values.length < 3) return state.margin;
  const diffs = [];
  for (let i = 1; i < values.length; i++) diffs.push(values[i] - values[i - 1]);
  return state.marginK * sampleStdev(diffs);
}

const EMPTY_SET = new Set();

function computePosts(round) {
  const posts = byRound.get(round) || [];
  const rows = [];
  const summary = { libre: 0, accessible: 0, limite: 0, pris: 0, pourvu: 0 };
  let placesOpen = 0;
  for (const post of posts) {
    if (!matchesFilters(post, state.subdivision, state.specialite, EMPTY_SET)) continue;
    const rank = effectiveRank(post);
    const margin = effectiveMargin(post);
    const status = statusOf(post, rank, margin);
    summary[status]++;
    if (OPEN_STATUSES.has(status)) placesOpen += status === "libre" ? post.restantes : post.places;
    let marge = null;
    if (rank !== null && post.rang_max !== null) marge = post.rang_max - rank;
    rows.push({
      gds: post.gds,
      specialite: post.specialite,
      subdivision: post.subdivision,
      places: post.places,
      restantes: post.restantes,
      attribuees: post.attribuees,
      rang_min: post.rang_min,
      rang_max: post.rang_max,
      nb_rangs: post.nb_rangs,
      status,
      marge,
      rank_used: rank,
      via_positionnement: rank !== null,
      margin_used: state.autoMargin && (status === "limite" || status === "pris") ? Math.round(margin) : null,
    });
  }
  const allRanks = posts.filter((p) => p.rang_max !== null).map((p) => p.rang_max);
  return {
    round,
    posts: rows,
    summary,
    total: rows.length,
    places_open: placesOpen,
    rank_ceiling: allRanks.length ? Math.max(...allRanks) : 0,
  };
}

const METRICS = {
  classement: "Classement des admis",
  accessibles: "Postes accessibles",
  places_accessibles: "Places accessibles",
  restantes: "Places restantes",
  postes: "Postes au total",
};

// "Places restantes" et "Places accessibles" ont une vraie valeur par poste (son nombre de
// places) : basculable entre le total cumulé sur le groupe et la distribution (médiane/quartiles/
// min-max) de cette valeur entre les postes du groupe. "Postes accessibles"/"Postes au total" sont
// de purs comptages (un poste est présent ou pas, il n'a pas de grandeur à distribuer) — pas de
// vue individuelle pour eux.
const INDIVIDUAL_CAPABLE = new Set(["restantes", "places_accessibles"]);

function metricLabel(metric, viewMode) {
  if (INDIVIDUAL_CAPABLE.has(metric) && viewMode === "individuel") {
    return metric === "restantes" ? "Places restantes par poste" : "Places accessibles par poste";
  }
  return METRICS[metric];
}

const MAX_SERIES = 40; // garde-fou d'affichage : au-delà, le graphique devient illisible

function bucketName(post, groupBy) {
  if (groupBy === "none") return "Sélection";
  if (groupBy === "poste") return `${post.specialite} — ${post.subdivision}`;
  return post[groupBy];
}

function computeEvolution(metric, groupBy) {
  const buckets = new Map(); // name -> Map<round, Post[]>
  for (const r of meta.rounds) {
    for (const post of byRound.get(r) || []) {
      if (!matchesFilters(post, state.subdivision, state.specialite, EMPTY_SET)) continue;
      const name = bucketName(post, groupBy);
      if (!buckets.has(name)) buckets.set(name, new Map());
      const perRound = buckets.get(name);
      if (!perRound.has(r)) perRound.set(r, []);
      perRound.get(r).push(post);
    }
  }

  const individuel = state.viewMode === "individuel";

  function computePoint(posts) {
    if (metric === "postes") return { value: posts.length };
    if (metric === "restantes") {
      if (individuel) {
        const stats = rankStats(posts.map((p) => p.restantes));
        return stats ? { value: stats.median, stats } : null;
      }
      return { value: posts.reduce((s, p) => s + p.restantes, 0) };
    }
    if (metric === "accessibles" || metric === "places_accessibles") {
      const open = posts.filter((p) => OPEN_STATUSES.has(statusOf(p, effectiveRank(p), effectiveMargin(p))));
      if (metric === "accessibles") return { value: open.length };
      if (individuel) {
        const stats = rankStats(open.map((p) => (p.restantes > 0 ? p.restantes : p.places)));
        return stats ? { value: stats.median, stats } : null;
      }
      return { value: open.reduce((s, p) => s + (p.restantes > 0 ? p.restantes : p.places), 0) };
    }
    // Population = le rang de CHAQUE candidat admis sur les postes du groupe ce tour-là (un
    // poste a en général plusieurs places, donc plusieurs admis à des rangs différents) — pas
    // le dernier rang pris de chaque poste comparé entre postes. Avec un seul poste sélectionné,
    // ça reste une vraie distribution dès qu'il a plus d'un admis.
    const ranks = posts.flatMap((p) => p.rangs || []);
    const stats = rankStats(ranks);
    if (!stats) return null;
    return { value: stats.median, stats };
  }

  let series = [];
  for (const [key, perRound] of buckets) {
    const points = [];
    for (const r of meta.rounds) {
      if (!perRound.has(r)) continue;
      const res = computePoint(perRound.get(r));
      points.push(res === null ? { round: r, value: null } : { round: r, ...res });
    }
    if (points.some((p) => p.value !== null)) series.push({ key, name: key, points });
  }

  series.sort((a, b) => {
    const maxA = Math.max(...a.points.map((p) => p.value ?? 0));
    const maxB = Math.max(...b.points.map((p) => p.value ?? 0));
    return maxB - maxA;
  });
  const truncated = series.length > MAX_SERIES;
  if (truncated) series = series.slice(0, MAX_SERIES);
  return { rounds: meta.rounds, series, metric, metric_label: metricLabel(metric, state.viewMode), group: groupBy, truncated };
}

/* --------------------------------------------------------------- filtres -- */

function buildChecklist(kind, values) {
  const box = $(`#list-${kind}`);
  box.innerHTML = "";
  for (const value of values) {
    const label = document.createElement("label");
    label.dataset.value = value.toLowerCase();
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state[kind].has(value);
    input.addEventListener("change", () => {
      input.checked ? state[kind].add(value) : state[kind].delete(value);
      updateFilterSummary(kind);
      updateChecklistVisibility(otherKind(kind));
      refresh();
    });
    const span = document.createElement("span");
    span.textContent = value;
    label.append(input, span);
    box.append(label);
  }
}

function otherKind(kind) {
  return kind === "subdivision" ? "specialite" : "subdivision";
}

function isRelevant(kind, value) {
  const other = otherKind(kind);
  const showAll = kind === "subdivision" ? state.showAllVilles : state.showAllSpecialites;
  if (showAll || state[other].size === 0) return true;
  const map = kind === "subdivision" ? villesBySpecialite : specialitesByVille;
  for (const sel of state[other]) {
    if (map.get(sel)?.has(value)) return true;
  }
  return false;
}

function updateChecklistVisibility(kind) {
  const input = $(`[data-search="${kind}"]`);
  const needle = (input?.value || "").trim().toLowerCase();
  $(`#list-${kind}`)
    .querySelectorAll("label")
    .forEach((l) => {
      const value = l.textContent.trim();
      const matchesSearch = !needle || l.dataset.value.includes(needle);
      l.hidden = !matchesSearch || !isRelevant(kind, value);
    });
}

function updateFilterSummary(kind) {
  const el = $(`#summary-${kind}`);
  if (!el) return;
  const n = state[kind].size;
  const noun = kind === "subdivision" ? "ville" : "spécialité";
  if (n === 0) el.textContent = kind === "subdivision" ? "Toutes les villes" : "Toutes les spécialités";
  else el.textContent = `${n} ${noun}${n > 1 ? "s" : ""} sélectionnée${n > 1 ? "s" : ""}`;
}

function wireFilterButtons() {
  document.querySelectorAll("[data-all]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const kind = btn.dataset.all;
      visibleValues(kind).forEach((v) => state[kind].add(v));
      syncChecks(kind);
      updateFilterSummary(kind);
      updateChecklistVisibility(otherKind(kind));
      refresh();
    })
  );
  document.querySelectorAll("[data-none]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const kind = btn.dataset.none;
      visibleValues(kind).forEach((v) => state[kind].delete(v));
      syncChecks(kind);
      updateFilterSummary(kind);
      updateChecklistVisibility(otherKind(kind));
      refresh();
    })
  );
  document.querySelectorAll("[data-search]").forEach((input) =>
    input.addEventListener("input", () => updateChecklistVisibility(input.dataset.search))
  );
  document.querySelectorAll("[data-show-all]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const kind = cb.dataset.showAll;
      if (kind === "subdivision") state.showAllVilles = cb.checked;
      else state.showAllSpecialites = cb.checked;
      save();
      updateChecklistVisibility(kind);
    })
  );
}

function visibleValues(kind) {
  return [...$(`#list-${kind}`).querySelectorAll("label")]
    .filter((l) => !l.hidden)
    .map((l) => l.textContent.trim());
}

function syncChecks(kind) {
  $(`#list-${kind}`)
    .querySelectorAll("label")
    .forEach((l) => {
      l.querySelector("input").checked = state[kind].has(l.textContent.trim());
    });
}

/* ---------------------------------------------------------- menus déroulants -- */

function wireDropdowns() {
  const dropdowns = [...document.querySelectorAll(".dropdown")];
  const closeAll = (except) => {
    dropdowns.forEach((d) => {
      if (d !== except) {
        d.classList.remove("open");
        d.querySelector(".dropdown-trigger")?.setAttribute("aria-expanded", "false");
      }
    });
  };
  dropdowns.forEach((dd) => {
    const trigger = dd.querySelector(".dropdown-trigger");
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !dd.classList.contains("open");
      closeAll(willOpen ? dd : null);
      dd.classList.toggle("open", willOpen);
      trigger.setAttribute("aria-expanded", String(willOpen));
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dropdown")) closeAll(null);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAll(null);
  });
}

/* ------------------------------------------------------------------ marge -- */

function updateMarginUI() {
  $("#autoMargin").checked = state.autoMargin;
  $("#manualMarginRow").hidden = state.autoMargin;
  $("#manualMarginNote").hidden = state.autoMargin;
  $("#autoMarginRow").hidden = !state.autoMargin;
  $("#autoMarginNote").hidden = !state.autoMargin;
}

function wireMargin() {
  $("#autoMargin").addEventListener("change", (e) => {
    state.autoMargin = e.target.checked;
    updateMarginUI();
    refresh();
  });
  $("#marginK").addEventListener("input", (e) => {
    state.marginK = Number(e.target.value);
    $("#marginKOut").textContent = state.marginK.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "×";
    refresh();
  });
}

/* ------------------------------------------------------- positionnements -- */

function stripToTable(raw) {
  // Coller la page EVEN/Galien entière embarque plein de texte parasite (dates de phases,
  // commentaires du CNG...) avant le tableau "Mes vœux" — sans ce nettoyage, la stratégie 3
  // ci-dessous peut confondre une date comme "17/08/2026" avec un code de positionnement, ou
  // pire, avaler tout le texte parasite dans le libellé de la première ligne. On ne garde que
  // ce qui suit ce repère (sa dernière occurrence, si jamais il apparaît plusieurs fois).
  const marker = /mes\s+(?:voeux|vœux)/i;
  const found = raw.match(marker);
  if (!found) return raw;
  const lastIdx = raw.toLowerCase().lastIndexOf(found[0].toLowerCase());
  return raw.slice(lastIdx + found[0].length);
}

function parseWishlistRaw(raw) {
  raw = stripToTable(raw);
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  // Stratégie 1 : une ligne par positionnement "rang  label  code"
  const singleLine = lines.map((l) => l.match(/^(\d{1,2})[.\s]+(.+?)\s+(\d{3,})$/));
  if (singleLine.every(Boolean)) {
    return singleLine.map((m, i) => ({ rank: i + 1, label: m[2].trim(), code: m[3] }));
  }

  // Stratégie 2 : trois lignes par positionnement (rang / label / code), copié cellule par cellule
  if (lines.length % 3 === 0) {
    const out = [];
    for (let i = 0; i < lines.length; i += 3) {
      const [a, b, c] = lines.slice(i, i + 3);
      if (/^\d{1,2}$/.test(a) && /^\d{3,}$/.test(c) && b) out.push({ rank: out.length + 1, label: b, code: c });
    }
    if (out.length === lines.length / 3) return out;
  }

  // Stratégie 3 : générique — tolère un collage en vrac (retours à la ligne au milieu d'un
  // libellé, espaces multiples...). On repère juste la séquence "petit nombre … texte … grand
  // nombre" n'importe où dans le texte. Les erreurs se corrigent ensuite à la main (étape éditable).
  const blob = lines.join("\n");
  const generic = [...blob.matchAll(/(\d{1,2})[\s]+([\s\S]+?)[\s]+(\d{3,})(?=\s|$)/g)];
  // Si le repère "Mes vœux" n'a pas été trouvé (paste tronqué différemment), cette stratégie
  // peut encore accrocher un pavé de texte parasite entre deux nombres isolés — un libellé
  // anormalement long trahit ce cas plutôt qu'un vrai nom de groupe.
  if (generic.length && generic.every((m) => m[2].length <= 120)) {
    return generic.map((m, i) => ({ rank: i + 1, label: m[2].replace(/\s+/g, " ").trim(), code: m[3] }));
  }

  return null;
}

function renderWishlist() {
  const has = state.wishlist.length > 0;
  $("#wishlistView").hidden = !has;
  $("#wishlistPrompt").hidden = has;
  if (has) {
    // Trié du meilleur (plus petit) au moins bon classement — c'est un classement, pas un ordre
    // de préférence, donc l'ordre de saisie (indice fixe du GDS) n'a pas de sens à afficher ici.
    const sorted = [...state.wishlist].sort((a, b) => Number(a.code) - Number(b.code));
    $("#wishlistList").innerHTML = sorted
      .map((w) => `<li>${esc(w.label)}<span class="wishlist-code">${fmt(Number(w.code))}</span></li>`)
      .join("");
  }
}

function wishlistRowHTML(w) {
  return `<div class="wishlist-edit-row">
    <input type="number" class="rank-input" min="1" value="${w.rank}">
    <input type="text" value="${esc(w.label)}" placeholder="Nom du groupe">
    <input type="text" value="${esc(w.code)}" placeholder="Classement">
    <button type="button" class="wishlist-row-remove" title="Supprimer cette ligne" aria-label="Supprimer cette ligne">×</button>
  </div>`;
}

function wireWishlistRow(row) {
  row.querySelector(".wishlist-row-remove").addEventListener("click", () => row.remove());
}

function openWishlistDialog() {
  const dlg = $("#wishlistDialog");
  $("#wishlistStepPaste").hidden = false;
  $("#wishlistStepEdit").hidden = true;
  $("#wishlistParseError").hidden = true;
  $("#wishlistPasteArea").value = state.wishlist.length
    ? state.wishlist.map((w) => `${w.rank}\t${w.label}\t${w.code}`).join("\n")
    : "";
  dlg.showModal();
}

function showWishlistEditor(rows) {
  $("#wishlistStepPaste").hidden = true;
  $("#wishlistStepEdit").hidden = false;
  const list = $("#wishlistEditList");
  list.innerHTML = rows.map(wishlistRowHTML).join("");
  list.querySelectorAll(".wishlist-edit-row").forEach(wireWishlistRow);
}

function wireWishlist() {
  $("#wishlistOpen").addEventListener("click", openWishlistDialog);
  $("#wishlistEdit")?.addEventListener("click", openWishlistDialog);
  $("#wishlistCancel1").addEventListener("click", () => $("#wishlistDialog").close());
  $("#wishlistClear").addEventListener("click", () => {
    state.wishlist = [];
    save();
    renderWishlist();
    updateGroupHint();
    if ($("#view-table").hidden) renderChart();
    else renderPosts();
  });

  $("#wishlistAnalyze").addEventListener("click", () => {
    const parsed = parseWishlistRaw($("#wishlistPasteArea").value);
    if (!parsed || !parsed.length) {
      $("#wishlistParseError").hidden = false;
      $("#wishlistParseError").textContent =
        "Format non reconnu — vérifie le texte collé, ou clique « Remplir à la main » pour saisir tes positionnements directement.";
      return;
    }
    $("#wishlistParseError").hidden = true;
    showWishlistEditor(parsed);
  });

  $("#wishlistManual").addEventListener("click", () => {
    $("#wishlistParseError").hidden = true;
    showWishlistEditor([]);
  });

  $("#wishlistAddRow").addEventListener("click", () => {
    const list = $("#wishlistEditList");
    const nextRank = list.querySelectorAll(".wishlist-edit-row").length + 1;
    const div = document.createElement("div");
    div.innerHTML = wishlistRowHTML({ rank: nextRank, label: "", code: "" });
    const row = div.firstElementChild;
    list.append(row);
    wireWishlistRow(row);
    row.querySelector("input[type=text]").focus();
  });

  $("#wishlistBack").addEventListener("click", () => {
    $("#wishlistStepEdit").hidden = true;
    $("#wishlistStepPaste").hidden = false;
  });

  $("#wishlistConfirm").addEventListener("click", () => {
    const rows = [...$("#wishlistEditList").querySelectorAll(".wishlist-edit-row")];
    const parsed = rows
      .map((row) => {
        const inputs = row.querySelectorAll("input");
        return {
          rank: parseInt(inputs[0].value, 10) || 0,
          label: inputs[1].value.trim(),
          code: inputs[2].value.trim(),
        };
      })
      .filter((w) => w.label)
      .sort((a, b) => a.rank - b.rank);

    state.wishlist = parsed;
    save();
    renderWishlist();
    updateGroupHint();
    $("#wishlistDialog").close();
    if ($("#view-table").hidden) renderChart();
    else renderPosts();
  });
}

function applyWishlist(series) {
  if (state.group !== "gds" || !state.wishlist.length) return series;
  // "code" = ton classement dans ce groupe (pas un ordre de préférence) — on affiche cette
  // valeur sur la courbe et on trie du meilleur (plus petit) classement au moins bon : c'est
  // l'info qui te dit directement où tu en es pour chaque groupe.
  const classementOf = new Map(state.wishlist.map((w) => [w.label, Number(w.code)]));
  return series
    .map((s) => ({
      ...s,
      name: classementOf.has(s.key) ? `${s.key} (ton classement : ${fmt(classementOf.get(s.key))})` : s.key,
      _wish: classementOf.has(s.key) ? classementOf.get(s.key) : Infinity,
    }))
    .sort((a, b) => a._wish - b._wish);
}

/* ----------------------------------------------------------------- table -- */

function renderPosts() {
  const data = computePosts(state.round);
  state.round = data.round;
  $("#round").value = data.round;
  $("#rankHint").textContent = data.rank_ceiling
    ? `${roundLabel(data.round)} · dernier rang classé : ${fmt(data.rank_ceiling)}`
    : "sur —";

  const labels = {
    libre: "libres",
    accessible: "accessibles",
    limite: "limite",
    pris: "hors d'atteinte",
    pourvu: "pourvus",
  };
  $("#tally").innerHTML = Object.entries(data.summary)
    .filter(([k, v]) => v > 0 && (state.wishlist.length || k === "libre" || k === "pourvu"))
    .map(([k, v]) => {
      const on = state.statusFilter.has(k);
      return `<button type="button" class="chip${on ? " chip-on" : ""}" data-k="${k}" aria-pressed="${on}">
        <b>${fmt(v)}</b><span>${labels[k]}</span></button>`;
    })
    .join("");
  $("#tally").querySelectorAll(".chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      const k = chip.dataset.k;
      state.statusFilter.has(k) ? state.statusFilter.delete(k) : state.statusFilter.add(k);
      save();
      renderPosts();
    })
  );

  lastPosts = data.posts;
  lastCeiling = data.rank_ceiling;
  renderTable(lastCeiling);
}

function renderTable(ceiling) {
  const rows = state.statusFilter.size
    ? lastPosts.filter((p) => state.statusFilter.has(p.status))
    : lastPosts;

  const { key, dir } = state.sort;
  rows.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    if (typeof x === "string") return dir * x.localeCompare(y, "fr");
    return dir * (x - y);
  });

  document.querySelectorAll("thead th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === key);
    th.classList.toggle("asc", th.dataset.sort === key && dir === 1);
  });

  const maxUsedRank = rows.reduce((m, p) => Math.max(m, p.rank_used || 0), 0);
  const scale = Math.max(ceiling || 1, maxUsedRank || 1);
  const pct = (v) => Math.min(100, (v / scale) * 100);

  $("#posts").tBodies[0].innerHTML = rows
    .map((p) => {
      let ruler;
      if (p.rang_min === null) {
        ruler = `<span class="ruler-free">aucun rang pris</span>`;
      } else {
        const left = pct(p.rang_min);
        const width = Math.max(1.2, pct(p.rang_max) - left);
        ruler = `<span class="ruler-band" style="left:${left}%;width:${width}%"></span>`;
      }
      const me = p.rank_used ? `<span class="ruler-me" style="left:${pct(p.rank_used)}%"></span>` : "";
      const marge =
        p.marge === null
          ? "—"
          : `<span class="marge ${p.marge >= 0 ? "ok" : "ko"}">${p.marge >= 0 ? "+" : ""}${fmt(p.marge)}</span>`;

      const titleBits = [];
      if (p.via_positionnement) titleBits.push(`ton classement pour ce groupe : ${fmt(p.rank_used)}`);
      if (p.margin_used !== null && p.margin_used !== undefined) titleBits.push(`marge statistique appliquée : ±${fmt(p.margin_used)}`);
      const rowTitle = titleBits.length ? ` title="${esc(titleBits.join(" · "))}"` : "";

      return `<tr data-status="${p.status}"${rowTitle}>
        <td class="txt"><span class="spec" title="${esc(p.specialite)}">${esc(p.specialite)}</span>
            <span class="gds">${esc(p.gds)}${p.via_positionnement ? ' <span class="pos-flag">•</span>' : ""}</span></td>
        <td class="txt">${esc(p.subdivision)}</td>
        <td class="num">${p.places}</td>
        <td class="num">${p.restantes || ""}</td>
        <td class="num">${fmt(p.rang_min)}</td>
        <td class="num">${fmt(p.rang_max)}</td>
        <td class="num">${marge}</td>
        <td><div class="ruler"><span class="ruler-track"></span>${ruler}${me}</div></td>
      </tr>`;
    })
    .join("");

  $("#count").textContent = `${rows.length} ligne${rows.length > 1 ? "s" : ""}`;
  const empty = $("#tableEmpty");
  empty.hidden = rows.length > 0;
  empty.textContent = "Aucun poste ne correspond. Élargis les villes ou les spécialités.";
}

/* ------------------------------------------------------------ graphique -- */

const PALETTE = [
  "#1d5570", "#a8452f", "#2a7a54", "#7a4a86", "#9d6a1c",
  "#2f8f9e", "#8b3f50", "#4a6a2c", "#c0693f", "#3f5ea8",
  "#7d6a2a", "#6b4a9e",
];

function updateGroupHint() {
  const hint = $("#groupHint");
  if (state.group === "poste") {
    hint.hidden = false;
    hint.textContent = "Coche des spécialités et des villes dans le panneau de gauche : chaque combinaison cochée devient sa propre courbe (ex. Médecine générale + APHM, Toulouse → 2 courbes).";
  } else if (state.group === "gds" && state.wishlist.length) {
    hint.hidden = false;
    hint.textContent = "Courbes triées par ton classement (meilleur d'abord) selon tes positionnements enregistrés (panneau de gauche).";
  } else if (state.group === "gds") {
    hint.hidden = false;
    hint.textContent = "Astuce : enregistre tes positionnements dans le panneau de gauche pour voir directement ton classement sur chaque courbe.";
  } else {
    hint.hidden = true;
  }
}

function updateViewModeVisibility() {
  const toggle = $("#viewModeToggle");
  const capable = INDIVIDUAL_CAPABLE.has(state.metric);
  toggle.hidden = !capable;
  if (!capable && state.viewMode === "individuel") {
    // Le toggle n'a de sens que pour restantes/places_accessibles : repartir du cumulé sur les
    // autres mesures évite qu'un choix fait sur l'une reste appliqué silencieusement à l'autre.
    state.viewMode = "cumule";
    $("#viewModeCheckbox").checked = false;
    save();
  }
}

function renderChart() {
  updateGroupHint();
  updateViewModeVisibility();
  const data = computeEvolution(state.metric, state.group);
  data.series = applyWishlist(data.series);
  drawChart(data);
}

function drawChart(data) {
  const host = $("#chart");
  const empty = $("#chartEmpty");
  const shown = data.series.filter((s) => !state.hidden.has(s.key));

  const truncNote = $("#chartTruncNote");
  truncNote.hidden = !data.truncated;
  if (data.truncated) {
    truncNote.textContent = `Affichage limité aux ${data.series.length} courbes les plus marquantes — affine les villes/spécialités cochées pour voir le reste.`;
  }

  const individuelView = INDIVIDUAL_CAPABLE.has(data.metric) && state.viewMode === "individuel";
  const hasStats = data.metric === "classement" || individuelView;
  const hasSpread = shown.some((s) => s.points.some((p) => p.stats && p.stats.min !== p.stats.max));
  $("#statsLegend").hidden = !(hasStats && hasSpread);
  if (hasStats && hasSpread) {
    $("#statsLegend").textContent = individuelView
      ? "Zone = écart interquartile (Q1–Q3) · trait plein = médiane · barres = min–max, calculés sur le nombre de places de chaque poste du groupe."
      : "Zone = écart interquartile (Q1–Q3) · trait plein = médiane · barres = min–max, calculés sur le rang de chaque candidat admis sur les postes du groupe.";
  }

  const sampleNote = $("#chartSampleNote");
  if (sampleNote) {
    const hasAnyPoint = shown.some((s) => s.points.some((p) => p.value !== null));
    sampleNote.hidden = !(hasStats && hasAnyPoint && !hasSpread);
    if (!sampleNote.hidden) {
      sampleNote.textContent = individuelView
        ? "Aucune dispersion à afficher ici : sur les tours tracés, les postes de cette sélection avaient tous le même nombre de places (ou un seul poste au total) — rien à comparer. Coche plus de villes ou de spécialités pour élargir l'échantillon."
        : "Aucune dispersion à afficher ici : sur les tours tracés, les postes de cette sélection n'ont jamais eu plus d'un candidat admis en même temps — pas assez de monde pour calculer une médiane/quartiles/min-max. Coche plus de villes ou de spécialités pour élargir l'échantillon.";
    }
  }

  if (!data.rounds.length || !shown.length) {
    host.innerHTML = "";
    $("#legend").innerHTML = "";
    empty.hidden = false;
    empty.textContent = data.rounds.length
      ? "Rien à tracer avec cette sélection."
      : "Aucun tour chargé. Lance fetch_appariement.sh puis recharge.";
    return;
  }
  empty.hidden = true;

  const W = 900, H = 420;
  const pad = { t: 18, r: 20, b: 42, l: 66 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const rounds = data.rounds;
  const xs = (r) =>
    pad.l + (rounds.length === 1 ? iw / 2 : (rounds.indexOf(r) / (rounds.length - 1)) * iw);

  const values = shown.flatMap((s) =>
    s.points.flatMap((p) => (hasStats && p.stats ? [p.stats.min, p.stats.max] : [p.value]))
  ).filter((v) => v !== null && v !== undefined);
  const vmax = Math.max(...values, 1);
  const vmin = Math.min(...values, 0);
  const top = niceCeil(vmax);
  const bottom = vmin < 0 ? -niceCeil(-vmin) : 0;
  const ys = (v) => pad.t + ih - ((v - bottom) / (top - bottom || 1)) * ih;

  const ticks = 5;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(data.metric_label)} par tour">`;

  for (let i = 0; i <= ticks; i++) {
    const v = bottom + ((top - bottom) * i) / ticks;
    const y = ys(v);
    svg += `<line class="grid-line" x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}"/>`;
    svg += `<text class="axis-text" x="${pad.l - 8}" y="${y + 3}" text-anchor="end">${shortNum(v)}</text>`;
  }
  svg += `<line class="axis-line" x1="${pad.l}" y1="${pad.t + ih}" x2="${W - pad.r}" y2="${pad.t + ih}"/>`;

  for (const r of rounds) {
    svg += `<text class="axis-text" x="${xs(r)}" y="${pad.t + ih + 18}" text-anchor="middle">${esc(roundShortLabel(r))}</text>`;
  }
  svg += `<text class="axis-title" x="${W / 2}" y="${H - 8}" text-anchor="middle">TOUR</text>`;
  svg += `<text class="axis-title" x="14" y="${pad.t + ih / 2}" text-anchor="middle" transform="rotate(-90 14 ${pad.t + ih / 2})">${esc(data.metric_label.toUpperCase())}</text>`;

  shown.forEach((s) => {
    const color = colorFor(s.key, data.series);
    const pts = s.points.filter((p) => p.value !== null);

    if (hasStats) {
      const withSpread = pts.filter((p) => p.stats && p.stats.q1 !== p.stats.q3);
      if (withSpread.length) {
        const top = withSpread.map((p) => `${xs(p.round)},${ys(p.stats.q3)}`);
        const bottom = withSpread.slice().reverse().map((p) => `${xs(p.round)},${ys(p.stats.q1)}`);
        svg += `<polygon class="band" points="${[...top, ...bottom].join(" ")}" fill="${color}"/>`;
      }
      pts.forEach((p) => {
        if (!p.stats || p.stats.min === p.stats.max) return;
        const x = xs(p.round);
        svg += `<line class="whisker" x1="${x}" y1="${ys(p.stats.min)}" x2="${x}" y2="${ys(p.stats.max)}" stroke="${color}"/>`;
        svg += `<line class="whisker-cap" x1="${x - 4}" y1="${ys(p.stats.min)}" x2="${x + 4}" y2="${ys(p.stats.min)}" stroke="${color}"/>`;
        svg += `<line class="whisker-cap" x1="${x - 4}" y1="${ys(p.stats.max)}" x2="${x + 4}" y2="${ys(p.stats.max)}" stroke="${color}"/>`;
      });
    }

    if (pts.length > 1) {
      const d = pts.map((p, i) => `${i ? "L" : "M"}${xs(p.round)},${ys(p.value)}`).join(" ");
      svg += `<path class="line" d="${d}" stroke="${color}"/>`;
    }
    pts.forEach((p) => {
      svg += `<circle class="dot" cx="${xs(p.round)}" cy="${ys(p.value)}" r="${pts.length > 1 ? 3.5 : 5}" fill="${color}"/>`;
    });
  });

  const bandW = rounds.length > 1 ? iw / (rounds.length - 1) : iw;
  rounds.forEach((r) => {
    svg += `<rect class="hover-band" data-round="${r}" x="${xs(r) - bandW / 2}" y="${pad.t}" width="${bandW}" height="${ih}"/>`;
  });
  svg += `</svg>`;

  host.style.position = "relative";
  host.innerHTML = svg;
  wireTooltip(host, shown, data);
  renderLegend(data.series);
}

function colorFor(key, all) {
  return PALETTE[all.findIndex((s) => s.key === key) % PALETTE.length];
}

function niceCeil(v) {
  if (v <= 10) return Math.ceil(v);
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / (mag / 2)) * (mag / 2);
}

function shortNum(v) {
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k";
  return Number.isInteger(v) ? v : v.toFixed(1);
}

function wireTooltip(host, shown, data) {
  let tip = host.querySelector(".tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    host.append(tip);
  }
  host.querySelectorAll(".hover-band").forEach((band) => {
    band.addEventListener("mousemove", (ev) => {
      const rnd = Number(band.dataset.round);
      const lines = shown
        .map((s) => {
          const pt = s.points.find((p) => p.round === rnd);
          if (!pt || pt.value === null) return null;
          const c = colorFor(s.key, data.series);
          const label = `<span class="swatch" style="background:${c}"></span>${esc(s.name)}`;
          if (pt.stats && pt.stats.min !== pt.stats.max) {
            const st = pt.stats;
            return `${label} médiane <b>${fmt(st.median)}</b>
              <span class="stat-range">[${fmt(st.min)}–${fmt(st.max)}], Q1 ${fmt(st.q1)} · Q3 ${fmt(st.q3)} · n=${st.n}</span>`;
          }
          return `${label} <b>${fmt(pt.value)}</b>`;
        })
        .filter(Boolean);
      if (!lines.length) return;
      tip.innerHTML = `<b>${esc(roundLabel(rnd))}</b><br>${lines.join("<br>")}`;
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      const x = ev.clientX - box.left;
      tip.style.left = Math.min(x + 14, box.width - tip.offsetWidth - 8) + "px";
      tip.style.top = Math.max(8, ev.clientY - box.top - tip.offsetHeight - 10) + "px";
    });
    band.addEventListener("mouseleave", () => { tip.hidden = true; });
  });
}

function renderLegend(series) {
  const box = $("#legend");
  if (series.length < 2 && series[0]?.key === "Sélection") {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = series
    .map((s, i) => {
      const off = state.hidden.has(s.key) ? " off" : "";
      const c = PALETTE[i % PALETTE.length];
      return `<span class="legend-item${off}" data-key="${esc(s.key)}">
        <span class="legend-swatch" style="background:${c}"></span>${esc(s.name)}</span>`;
    })
    .join("");
  box.querySelectorAll(".legend-item").forEach((item) =>
    item.addEventListener("click", () => {
      const key = item.dataset.key;
      state.hidden.has(key) ? state.hidden.delete(key) : state.hidden.add(key);
      save();
      renderChart();
    })
  );
}

/* -------------------------------------------------------------- démarrage -- */

function indexData(bulk) {
  meta = {
    rounds: bulk.rounds,
    round_labels: bulk.round_labels,
    subdivisions: bulk.subdivisions,
    specialites: bulk.specialites,
    gds: bulk.gds,
  };
  ALL_POSTS = bulk.posts;
  byRound = new Map(meta.rounds.map((r) => [r, []]));
  for (const post of ALL_POSTS) {
    if (byRound.has(post.round)) byRound.get(post.round).push(post);
  }
  rankHistory = buildRankHistory(meta.rounds);

  // Pour filtrer les listes "villes"/"spécialités" l'une par l'autre : ne montrer une ville
  // que si elle a au moins un poste dans une des spécialités cochées (et réciproquement) —
  // "il n'existe pas le poste", pas juste "il n'y a personne dessus en ce moment".
  villesBySpecialite = new Map();
  specialitesByVille = new Map();
  for (const post of ALL_POSTS) {
    if (!post.specialite || !post.subdivision) continue;
    // places === 0 sur toutes les lignes d'une combinaison = poste fantôme (jamais aucune
    // capacité ouverte), pas juste "personne dessus en ce moment" (restantes === 0 avec
    // places > 0, ça, ça reste un vrai poste). On ne compte comme "existant" que le premier cas exclu.
    if (post.places <= 0) continue;
    if (!villesBySpecialite.has(post.specialite)) villesBySpecialite.set(post.specialite, new Set());
    villesBySpecialite.get(post.specialite).add(post.subdivision);
    if (!specialitesByVille.has(post.subdivision)) specialitesByVille.set(post.subdivision, new Set());
    specialitesByVille.get(post.subdivision).add(post.specialite);
  }
}

async function boot() {
  restore();
  let bulk;
  try {
    bulk = await fetchJSON("data.json");
  } catch (e) {
    $("#bootLoadingText").textContent = "Échec du chargement : " + e.message;
    $(".boot-spinner")?.remove();
    return;
  }
  indexData(bulk);

  if (!meta.rounds.length) {
    $("#bootLoadingText").textContent = "Aucun tour chargé — lance fetch_appariement.sh puis recharge.";
    $(".boot-spinner")?.remove();
    return;
  }

  const sel = $("#round");
  sel.innerHTML = meta.rounds.map((r) => `<option value="${r}">${esc(roundLabel(r))}</option>`).join("");
  if (!meta.rounds.includes(state.round)) state.round = meta.rounds.at(-1);
  sel.value = state.round;
  $("#roundNote").textContent = `${meta.rounds.length} tour(s) chargé(s) — ${(byRound.get(state.round) || []).length} postes pour : ${roundLabel(state.round)}.`;

  buildChecklist("subdivision", meta.subdivisions);
  buildChecklist("specialite", meta.specialites);
  updateFilterSummary("subdivision");
  updateFilterSummary("specialite");
  wireFilterButtons();
  wireDropdowns();
  $("#showAllVilles").checked = state.showAllVilles;
  $("#showAllSpecialites").checked = state.showAllSpecialites;
  updateChecklistVisibility("subdivision");
  updateChecklistVisibility("specialite");

  $("#margin").value = state.margin;
  $("#marginOut").value = state.margin;
  $("#marginK").value = state.marginK;
  $("#marginKOut").textContent = state.marginK.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "×";
  updateMarginUI();
  wireMargin();
  renderWishlist();
  wireWishlist();
  $("#metric").value = state.metric;
  $("#group").value = state.group;
  $("#viewModeCheckbox").checked = state.viewMode === "individuel";
  updateGroupHint();
  updateViewModeVisibility();

  sel.addEventListener("change", (e) => { state.round = Number(e.target.value); refresh(); });
  $("#margin").addEventListener("input", (e) => {
    state.margin = Number(e.target.value);
    $("#marginOut").value = state.margin;
    refresh();
  });
  $("#metric").addEventListener("change", (e) => {
    state.metric = e.target.value;
    updateViewModeVisibility();
    refresh();
  });
  $("#viewModeCheckbox").addEventListener("change", (e) => {
    state.viewMode = e.target.checked ? "individuel" : "cumule";
    refresh();
  });
  $("#group").addEventListener("change", (e) => {
    state.group = e.target.value;
    state.hidden.clear();
    if (state.group === "poste") {
      state.metric = "classement";
      $("#metric").value = state.metric;
    }
    updateGroupHint();
    refresh();
  });

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => {
        const on = t === tab;
        t.classList.toggle("is-on", on);
        t.setAttribute("aria-selected", String(on));
      });
      const isTable = tab.dataset.view === "table";
      $("#view-table").hidden = !isTable;
      $("#view-chart").hidden = isTable;
      isTable ? renderPosts() : renderChart();
    })
  );

  document.querySelectorAll("thead th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : -1 };
      save();
      renderTable(lastCeiling);
    })
  );

  window.addEventListener("resize", () => {
    if (!$("#view-chart").hidden) renderChart();
  });

  renderPosts();
  $("#bootLoading").hidden = true;

  // Rien en localStorage : invite tout de suite à renseigner les positionnements plutôt
  // que de laisser le bouton discret dans la sidebar passer inaperçu.
  if (!state.wishlist.length) openWishlistDialog();
}

boot();
