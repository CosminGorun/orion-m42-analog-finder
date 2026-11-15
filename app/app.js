/* Analog Finder.
 * Data comes from app/data/*.json, produced by the scripts in pipeline/.
 * Scores are computed here in the browser so weights and views update instantly.
 */
"use strict";

const SHARP = 6;            // how fast a criterion score drops as a cell moves away from the target (percentile part)
const SITE_SHARE = 0.01;    // candidate sites = connected groups of cells in the top 1% of land
const NEW_KM = 300;         // "new site" = farther than this from every known analog site
const ROBUST_RUNS = 300;
const TOP_PINS = 10;

const S = {
  grid: null, criteria: [], targets: [], known: [],
  target: null, weights: {}, posOf: null, sub: null,
  score: null, maxScore: 1, robustness: null, clusters: [], clusterOf: null,
  mode: "similarity", criterion: null, topShare: 0.01, selected: undefined,
  body: null, problem: "all", pr: {}, cover: null, coverN: 0, view: "explore", scenario: "normal",
  map: null, overlay: null, base: {}, knownLayer: null, pinLayer: null, selMarker: null,
};

// ---------- formatting ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const nf = (d) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v)) ? "—" : nf(d).format(v).replace("-", "−");
const pct = (v) => `${Math.round(v * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtLat = (v) => `${fmt(Math.abs(v), 2)}°${v < 0 ? "S" : "N"}`;
const fmtLon = (v) => `${fmt(Math.abs(v), 2)}°${v < 0 ? "W" : "E"}`;
const fmtCoord = (lat, lon) => `${fmtLat(lat)}, ${fmtLon(lon)}`;
const unit = (c) => (c.unit ? (c.unit === "°" || c.unit === "%" ? c.unit : ` ${c.unit}`) : "");
const fmtVal = (c, v) => c.binary ? (v === null ? "—" : v ? "Yes" : "No") : `${fmt(v, c.decimals)}${unit(c)}`;

const ICON = {
  check: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="var(--good)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="var(--bad)" stroke-width="2" stroke-linecap="round"/></svg>',
  warn: '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l7 12.5H1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v4M8 11.8v.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  close: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

// ---------- colour ----------
let RAMP = [];   // sequential green ramp, dark -> bright (read from CSS tokens)
function hexToRgb(h) { h = h.trim().replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function rampAt(t) {
  t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(Math.floor(t), RAMP.length - 2), f = t - i;
  return RAMP[i].map((a, k) => Math.round(a + (RAMP[i + 1][k] - a) * f));
}
const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const scoreInk = (s) => (s >= 0.7 ? "var(--good)" : s >= 0.4 ? "var(--warn)" : "var(--bad)");

// ---------- geometry ----------
function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
function cellLatLon(idx) {
  const { res, nlon } = S.grid, i = Math.floor(idx / nlon), j = idx % nlon;
  return [-90 + (i + 0.5) * res, -180 + (j + 0.5) * res];
}
function posAt(latlng) {
  const { res, nlon, nlat } = S.grid;
  const i = Math.floor((latlng.lat + 90) / res), j = Math.floor((latlng.lng + 180) / res);
  if (i < 0 || i >= nlat || j < 0 || j >= nlon) return -1;
  return S.posOf[i * nlon + j];
}
function nearestKnown(lat, lon) {
  let best = null;
  for (const k of S.known) {
    const d = haversineKm(lat, lon, k.lat, k.lon);
    if (!best || d < best.km) best = { ...k, km: d };
  }
  return best;
}

// ---------- scoring ----------
// Percentile rank of a value within Earth's land distribution (0..1); plateaus (e.g. many zeros) get their midpoint.
function rankFn(q) {
  const n = q.length - 1;
  return (x) => {
    if (x <= q[0]) return x < q[0] ? 0 : upper(q, x) / 2 / n;
    if (x >= q[n]) return x > q[n] ? 1 : (lower(q, x) + n) / 2 / n;
    const lo = lower(q, x), hi = upper(q, x);
    if (hi >= lo) return (lo + hi) / 2 / n;
    return (hi + (x - q[hi]) / (q[lo] - q[hi] || 1)) / n;
  };
}
function lower(q, x) { let a = 0, b = q.length; while (a < b) { const m = (a + b) >> 1; q[m] < x ? a = m + 1 : b = m; } return a; }
function upper(q, x) { let a = 0, b = q.length; while (a < b) { const m = (a + b) >> 1; q[m] <= x ? a = m + 1 : b = m; } return a - 1; }

function targetInfo(c) {
  const t = S.target.values[c.id], st = S.grid.stats[c.id];
  if (t === null || t === undefined) return { t: null, clamped: null, outside: false, st, na: true };
  const clamped = Math.max(st.min, Math.min(st.max, t));
  return { t, clamped, outside: t < st.min || t > st.max, st, na: false };
}
// Criteria the target does not define (null) are left out of its score, weights and views.
// "lower"/"higher" criteria score against fixed thresholds, so they need no target value; they apply by body and scenario.
const oneSided = (c) => c.mode === "lower" || c.mode === "higher";
const applicable = (c) => {
  if (!S.target) return false;
  if (c.bodies && !c.bodies.includes(S.target.body)) return false;
  if (c.scenario && c.scenario !== S.scenario) return false;
  if (oneSided(c)) return true;
  const v = S.target.values[c.id];
  return v !== null && v !== undefined;
};
const targetText = (c, info) => (c.mode === "lower" ? "lower is better" : c.mode === "higher" ? "higher is better" : fmtVal(c, info.t));
const activeCriteria = () => S.criteria.filter(applicable);

// Criterion score = geometric mean of (a) closeness in percentile rank and (b) closeness in actual value,
// so 2,600 m and 5,300 m of relief are not treated as equal just because both sit in Earth's top 1%.
function computeSub() {
  const n = S.grid.cells.length, K = S.criteria.length;
  S.sub = new Float32Array(n * K);
  S.criteria.forEach((c, k) => {
    const vals = S.grid.values[c.id], info = targetInfo(c);
    if (!applicable(c)) { for (let p = 0; p < n; p++) S.sub[p * K + k] = NaN; return; }
    if (oneSided(c)) {
      // ramp between two fixed thresholds: 1 at the good end, 0 at the bad end
      const span = (c.hi - c.lo) || 1;
      for (let p = 0; p < n; p++) {
        const x = vals[p];
        if (x === null) { S.sub[p * K + k] = NaN; continue; }
        const r = Math.max(0, Math.min(1, (x - c.lo) / span));
        S.sub[p * K + k] = c.mode === "lower" ? 1 - r : r;
      }
      return;
    }
    if (c.binary) {
      for (let p = 0; p < n; p++) S.sub[p * K + k] = vals[p] === null ? NaN : (vals[p] === info.clamped ? 1 : 0);
      return;
    }
    const rank = rankFn(S.grid.quantiles[c.id]), rt = rank(info.clamped);
    const span = (info.st.max - info.st.min) || 1;
    for (let p = 0; p < n; p++) {
      const x = vals[p];
      if (x === null) { S.sub[p * K + k] = NaN; continue; }
      const sRank = Math.pow(1 - Math.abs(rank(x) - rt), SHARP);
      const sVal = Math.pow(Math.max(0, 1 - Math.abs(x - info.clamped) / span), 2);
      S.sub[p * K + k] = Math.sqrt(sRank * sVal);
    }
  });
}

// Total = weighted mean of available criteria, gently penalised when data is missing.
function scoreAll(weights, out) {
  const n = S.grid.cells.length, K = S.criteria.length;
  const w = S.criteria.map((c) => (applicable(c) ? weights[c.id] : 0));
  const wAll = w.reduce((a, b) => a + b, 0) || 1;
  for (let p = 0; p < n; p++) {
    let num = 0, den = 0;
    for (let k = 0; k < K; k++) {
      const s = S.sub[p * K + k];
      if (!Number.isNaN(s) && w[k] > 0) { num += w[k] * s; den += w[k]; }
    }
    out[p] = den ? (num / den) * Math.sqrt(den / wAll) : 0;
  }
  return out;
}

// ---------- test problems ----------
// A test problem is a preset of weights over the criteria. "pending" problems need data the pipeline does not load yet.
const COVER_SHARE = 0.05;   // a cell "covers" a problem when it is in the top 5% of land for it
// "core" lists the criteria a problem cannot do without (default: all of them). A problem whose core criteria
// are not in the data yet shows as "soon"; one whose core criteria do not apply to the target is switched off.
// "group" places a problem in the setup bar; its icon is TEST_ICONS[id] (icons.js).
const PROBLEM_GROUPS = [
  { id: "overall", name: "Overall" },
  { id: "terrain", name: "Terrain" },
  { id: "env", name: "Environment" },
  { id: "res", name: "Resources and life" },
];
const PROBLEMS = [
  { id: "all", group: "overall", name: "Full match", hint: "every criterion the target defines" },
  { id: "terrain", group: "terrain", name: "Landing and terrain", short: "Terrain", hint: "slopes, relief, roughness", crit: { slope_mean: 1, slope_p90: 1, relief: 1, roughness: 1 } },
  { id: "craters", group: "terrain", name: "Craters", short: "Craters", hint: "closed hollows, steep walls", crit: { dep_frac: 1, dep_depth: 1, slope_p90: 0.5, relief: 0.5 }, core: ["dep_frac", "dep_depth"] },
  { id: "dust", group: "env", name: "Dust and wind", short: "Dust", hint: "airborne dust, storms, wind", crit: { dust: 1, dust_storm: 1, wind: 0.5 }, why: "No atmosphere at this target" },
  { id: "cold", group: "env", name: "Cold and thermal cycling", short: "Cold", hint: "ground temperature, day–night swing", crit: { t_mean: 1, t_max: 1, t_swing: 1 } },
  { id: "light", group: "env", name: "Light and shadow", short: "Light", hint: "low Sun, polar day and night", crit: { low_sun: 1, polar_day: 0.5, polar_night: 0.5 }, core: ["low_sun"] },
  { id: "dry", group: "env", name: "Dryness and thin air", short: "Dry air", hint: "rain, soil moisture, pressure", crit: { precip: 1, soil_moist: 1, pressure: 0.5 }, core: ["precip", "pressure"] },
  { id: "ice", group: "res", name: "Ice and drilling", short: "Ice", hint: "ground ice, cold ground", crit: { ice: 1, t_mean: 0.5 }, core: ["ice"], needs: (t) => t.values.ice === 1, why: "No ground ice at this target" },
  { id: "caves", group: "terrain", name: "Caves", short: "Caves", hint: "lava-tube terrain, cave temperature", crit: { cave_temp: 1, basalt_dist: 1 }, needs: (t) => t.kind === "subsurface", why: "This target is not a pit or cave" },
  { id: "life", group: "res", name: "Life-detection tests", short: "Lifeless soil", hint: "no plants, few microbes", crit: { ndvi: 1, low_biomass: 1 } },
];
const problemById = (id) => PROBLEMS.find((p) => p.id === id);
const coreIds = (pr) => pr.core || Object.keys(pr.crit);
const problemPending = (pr) => pr.id !== "all" && !coreIds(pr).some((id) => S.criteria.some((c) => c.id === id));
function problemWeights(pr) {
  const w = {};
  S.criteria.forEach((c) => { w[c.id] = pr.id === "all" ? c.weight : (pr.crit[c.id] || 0); });
  return w;
}
function problemOk(pr) {
  if (pr.id === "all") return true;
  if (problemPending(pr)) return false;
  if (pr.needs && !pr.needs(S.target)) return false;
  return S.criteria.some((c) => coreIds(pr).includes(c.id) && applicable(c));
}
const coverIds = () => Object.keys(S.pr).filter((id) => id !== "all");

// One score per problem for every cell, plus how many problems each cell covers.
function computeProblems() {
  const n = S.grid.cells.length;
  S.pr = {};
  PROBLEMS.forEach((pr) => {
    if (!problemOk(pr)) return;
    const score = scoreAll(problemWeights(pr), new Float32Array(n));
    S.pr[pr.id] = { score, thr: topThreshold(score, COVER_SHARE) };
  });
  const ids = coverIds();
  S.cover = new Uint8Array(n);
  ids.forEach((id) => { const { score, thr } = S.pr[id]; if (thr > 0) for (let p = 0; p < n; p++) if (score[p] >= thr) S.cover[p]++; });
  S.coverN = ids.length;
}

function setProblem(id) {
  if (id === "combined") { S.problem = "combined"; S.weights = problemWeights(problemById("all")); S.mode = "coverage"; }
  else { S.problem = id; S.weights = problemWeights(problemById(id)); if (S.mode === "coverage") S.mode = "similarity"; }
  syncModeButtons();
  renderSetup();
  renderWeights();
  recompute();
}

// Round globe images for the destination switch (NASA Trek global mosaics, equirectangular 256 px tiles).
const BODY_IMG = {
  moon: "https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/0/0/0.jpg",
  mars: "https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/0/0/0.jpg",
};
const testIcon = (id) => `<span class="ptile-ic" aria-hidden="true">${(typeof TEST_ICONS !== "undefined" && TEST_ICONS[id]) || ""}</span>`;
const hasScenarioFor = (body) => S.criteria.some((c) => c.scenario && (!c.bodies || c.bodies.includes(body)));

function renderSetup() {
  const bodies = [...new Set(S.targets.map((t) => t.body))];
  $("#bodies").innerHTML = bodies.map((b) => `<button type="button" role="radio" class="body-opt" data-body="${b}" aria-checked="${b === S.body}">`
    + `<span class="body-orb"${BODY_IMG[b] ? ` style="--orb:url('${BODY_IMG[b]}')"` : ""} aria-hidden="true"></span><span class="body-name">${esc(BODY[b] || b)}</span></button>`).join("");
  const mine = S.targets.filter((t) => t.body === S.body), tg = [...new Set(mine.map((t) => t.group || "Targets"))];
  $("#target").innerHTML = tg.map((g) => `<optgroup label="${esc(g)}">${mine.filter((t) => (t.group || "Targets") === g)
    .map((t) => `<option value="${t.id}"${t.id === S.target.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</optgroup>`).join("");
  // the dust-storm scenario exists only where some criterion is tied to a scenario and applies to this body
  const hasScenario = hasScenarioFor(S.body), storm = hasScenario && S.scenario === "storm";
  const sb = $("#storm");
  sb.hidden = !hasScenario;
  sb.setAttribute("aria-pressed", String(storm));
  if (!sb.innerHTML) sb.innerHTML = (typeof TEST_ICONS !== "undefined" && TEST_ICONS.storm) || "";
  $("#target-note").innerHTML = (storm ? `<span class="storm-on">Dust storm scenario on</span>` : "") + esc(S.target.mission || "");
  $("#target-note").title = S.target.mission || "";
  const tile = (id, name, pressed, ok, why, pending, extra = "") =>
    `<button type="button" class="pchip ptile${pending ? " is-pending" : ""}${extra}" data-problem="${id}" aria-pressed="${pressed}"${ok ? "" : ` disabled title="${esc(why)}"`}>`
    + `${testIcon(id)}<span class="ptile-name">${esc(name)}</span>${pending ? "<small>soon</small>" : ""}</button>`;
  $("#problems").innerHTML = PROBLEM_GROUPS.map((g) => {
    const items = PROBLEMS.filter((pr) => (pr.group || "overall") === g.id).map((pr) => {
      const pending = problemPending(pr), ok = problemOk(pr);
      const why = pending ? "Data for this problem is not loaded yet" : (pr.why || "The target has no data for these criteria");
      return tile(pr.id, pr.name, S.problem === pr.id, ok, why, pending);
    });
    if (g.id === "overall") items.push(tile("combined", "All combined", S.problem === "combined", S.coverN > 1, "Needs at least two test problems for this target", false, " pchip-all"));
    return `<div class="pgroup" role="group" aria-label="${esc(g.name)}"><div class="pgroup-h">${esc(g.name)}</div><div class="pgroup-items">${items.join("")}</div></div>`;
  }).join("");
  // one-line summary shown when the test panel is collapsed
  const curName = S.problem === "combined" ? "All combined" : S.problem === "custom" ? "Custom weights" : problemById(S.problem).name;
  $("#tests-current").innerHTML = `${S.problem === "custom" ? "" : testIcon(S.problem)}<span class="ptile-name">${esc(curName)}</span>`;
  const pr = problemById(S.problem);
  $("#problem-note").textContent = S.problem === "combined"
    ? `The map shows how many of the ${S.coverN} test problems each place is in the top ${COVER_SHARE * 100}% of land for.`
    : S.problem === "custom" ? "Custom weights, set in the Weights tab."
    : pr.id === "all" ? `Uses all ${activeCriteria().length} criteria this target defines.`
    : `Uses: ${S.criteria.filter((c) => pr.crit[c.id] && applicable(c)).map((c) => c.name.toLowerCase()).join(", ")}.`;
}

function setScenario(sc) {
  if (sc === S.scenario) return;
  S.scenario = sc;
  selectTarget(S.target.id);
}

// The test panel folds to one line so the map gets the height; the choice is remembered per browser.
const TESTS_KEY = "analogFinder.testsCollapsed";
function setTestsCollapsed(on, save) {
  $("#setup").classList.toggle("is-collapsed", on);
  $("#tests-body").hidden = on;
  $("#tests-current").hidden = !on;
  const t = $("#tests-toggle");
  t.setAttribute("aria-expanded", String(!on));
  t.setAttribute("aria-label", on ? "Expand test panel" : "Collapse test panel");
  t.title = on ? "Expand" : "Collapse";
  if (save) { try { localStorage.setItem(TESTS_KEY, on ? "1" : "0"); } catch (e) { /* storage blocked */ } }
  if (S.map) S.map.invalidateSize();
}
function initTestsCollapse() {
  let on = false;
  try { on = localStorage.getItem(TESTS_KEY) === "1"; } catch (e) { /* storage blocked */ }
  setTestsCollapsed(on, false);
  $("#tests-toggle").addEventListener("click", () => setTestsCollapsed(!$("#setup").classList.contains("is-collapsed"), true));
  $("#tests-current").addEventListener("click", () => setTestsCollapsed(false, true));
}

function syncModeButtons() {
  $$("#view-modes button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === S.mode)));
  $("#criterion-field").hidden = S.mode !== "criterion";
  $("#top-field").hidden = S.mode !== "top";
  $("#viewctl-btn").classList.toggle("has-dot", S.mode !== "similarity");
}

// ---------- pages ----------
function setView(view) {
  S.view = view;
  $$(".mainnav button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  $("#view-explore").hidden = view !== "explore";
  $("#view-docs").hidden = view !== "docs";
  if (view === "explore") { S.map.invalidateSize(); fitMinimap(); renderMinimap(); }
  else closeViewPanel();
  if (view === "docs" && window.renderDocs) window.renderDocs();
}

function topThreshold(score, share) {
  const bins = new Uint32Array(1001);
  for (const s of score) bins[Math.min(1000, Math.floor(s * 1000))]++;
  let need = Math.ceil(score.length * share);
  for (let b = 1000; b >= 0; b--) { need -= bins[b]; if (need <= 0) return b / 1000; }
  return 0;
}

function buildClusters() {
  const { nlat, nlon } = S.grid, thr = topThreshold(S.score, SITE_SHARE);
  const seen = new Uint8Array(S.score.length), clusters = [];
  S.clusterOf = new Int32Array(S.score.length).fill(-1);
  for (let p0 = 0; p0 < S.score.length; p0++) {
    if (seen[p0] || S.score[p0] < thr) continue;
    const stack = [p0], cells = []; seen[p0] = 1;
    while (stack.length) {
      const p = stack.pop(); cells.push(p);
      const idx = S.grid.cells[p], i = Math.floor(idx / nlon), j = idx % nlon;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const ii = i + di, jj = (j + dj + nlon) % nlon;
        if (ii < 0 || ii >= nlat || (!di && !dj)) continue;
        const q = S.posOf[ii * nlon + jj];
        if (q >= 0 && !seen[q] && S.score[q] >= thr) { seen[q] = 1; stack.push(q); }
      }
    }
    let best = cells[0];
    for (const p of cells) if (S.score[p] > S.score[best]) best = p;
    const [lat, lon] = cellLatLon(S.grid.cells[best]);
    clusters.push({
      cells, best, lat, lon, bestScore: S.score[best],
      mean: cells.reduce((a, p) => a + S.score[p], 0) / cells.length,
      areaKm2: cells.reduce((a, p) => a + 3091 * Math.cos(cellLatLon(S.grid.cells[p])[0] * Math.PI / 180), 0),
      known: nearestKnown(lat, lon),
    });
  }
  clusters.sort((a, b) => b.bestScore - a.bestScore);
  clusters.forEach((c, r) => { c.rank = r + 1; c.cells.forEach((p) => { S.clusterOf[p] = r; }); });
  S.clusters = clusters;
}

function visibleClusters() {
  const onlyNew = $("#only-new").checked;
  return S.clusters.filter((c) => !onlyNew || c.known.km > NEW_KM);
}

function recompute() {
  S.score = scoreAll(S.weights, S.score || new Float32Array(S.grid.cells.length));
  S.maxScore = S.score.reduce((m, s) => (s > m ? s : m), 0) || 1;
  S.robustness = null;
  buildClusters();
  if (S.mode === "robustness") computeRobustness();
  renderKpis();
  renderOverlay();
  renderSites();
  renderPins();
  if (S.selected !== undefined) showDetail(S.selected);
}

function computeRobustness() {
  const n = S.grid.cells.length, hits = new Uint16Array(n), tmp = new Float32Array(n);
  for (let r = 0; r < ROBUST_RUNS; r++) {
    const w = {}; S.criteria.forEach((c) => { w[c.id] = applicable(c) ? Math.random() * 2 : 0; });
    scoreAll(w, tmp);
    const thr = topThreshold(tmp, SITE_SHARE);
    for (let p = 0; p < n; p++) if (tmp[p] >= thr) hits[p]++;
  }
  S.robustness = Float32Array.from(hits, (h) => h / ROBUST_RUNS);
}

// ---------- view modes ----------
// Each mode returns: value(p) in 0..1 (or null = transparent), legend classes, title and note.
const SIM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9];          // fractions of the best score
const SIM_NAMES = ["Very low", "Low", "Fair", "Moderate", "High", "Very high"];

function viewSpec() {
  const best = S.maxScore;
  if (S.mode === "similarity") {
    const edges = SIM_STEPS.map((f) => f * best);
    return {
      title: `Similarity to ${S.target.name}`,
      note: "Classes relative to the best match on Earth",
      value: (p) => { const s = S.score[p]; let k = 0; while (k < edges.length && s >= edges[k]) k++; return k / 5; },
      alpha: (v) => (v === 0 ? 70 : 235),
      classes: SIM_NAMES.map((name, k) => ({
        color: rampAt(k / 5), label: name,
        range: k === 0 ? `< ${pct(edges[0])}` : k === 5 ? `≥ ${pct(edges[4])}` : `${pct(edges[k - 1])}–${pct(edges[k])}`,
      })).reverse(),
    };
  }
  if (S.mode === "top") {
    const thr = topThreshold(S.score, S.topShare), span = (best - thr) || 1;
    const share = `${Math.round(S.topShare * 100)}%`;
    return {
      title: `Top ${share} of land`,
      note: `Only cells scoring ≥ ${pct(thr)} are shown`,
      value: (p) => (S.score[p] < thr ? null : 0.25 + 0.75 * Math.min(1, (S.score[p] - thr) / span)),
      alpha: () => 245,
      classes: [1, 0.75, 0.5, 0.25].map((t) => ({ color: rampAt(t), label: t === 1 ? "Best" : t === 0.25 ? "Threshold" : "", range: pct(thr + (t - 0.25) / 0.75 * span) })),
    };
  }
  if (S.mode === "criterion") {
    const K = S.criteria.length, k = S.criteria.findIndex((c) => c.id === S.criterion), c = S.criteria[k];
    return {
      title: `${c.name}: match score`,
      note: `Target ${fmtVal(c, S.target.values[c.id])}`,
      value: (p) => { const s = S.sub[p * K + k]; return Number.isNaN(s) ? null : s; },
      alpha: (v) => (v < 0.2 ? 60 : 235),
      classes: [1, 0.8, 0.6, 0.4, 0.2, 0].map((t) => ({ color: rampAt(t), label: "", range: t === 0 ? "0%" : `${pct(t - 0.2)}–${pct(t)}` })),
    };
  }
  if (S.mode === "coverage") {
    const N = S.coverN || 1;
    return {
      title: "Test problems covered",
      note: `In the top ${COVER_SHARE * 100}% of land for each problem`,
      value: (p) => (S.cover[p] ? S.cover[p] / N : null),
      alpha: () => 240,
      classes: Array.from({ length: N }, (_, i) => N - i).map((k) => ({ color: rampAt(k / N), label: k === N ? "All" : "", range: `${k} of ${N}` })),
    };
  }
  // robustness
  return {
    title: "Robustness to weights",
    note: `Share of ${ROBUST_RUNS} random weightings that keep the cell in the top 1%`,
    value: (p) => (S.robustness && S.robustness[p] > 0 ? S.robustness[p] : null),
    alpha: () => 240,
    classes: [1, 0.75, 0.5, 0.25, 0.01].map((t) => ({ color: rampAt(t), label: t === 1 ? "Always" : t === 0.01 ? "Rarely" : "", range: pct(t) })),
  };
}

// ---------- map ----------
// Web Mercator (Leaflet's default CRS) cannot show latitudes beyond ±85.0511°; markers further south sit on the edge.
const MERC_LAT = 85.0511;
// Dark basemap: Esri Dark Gray Canvas (CARTO dark_all now answers every tile with an "API key required" image).
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const DARK_BASE = ESRI + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const DARK_ATTR = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function initMap() {
  // a little horizontal slack so sites near the date line can still be centred beside the detail panel
  S.map = L.map("map", {
    center: [20, 10], zoom: 2, minZoom: 2, maxZoom: 18, zoomSnap: 0.25, zoomControl: false, worldCopyJump: false,
    maxBounds: [[-MERC_LAT, -225], [MERC_LAT, 225]], maxBoundsViscosity: 1,
  });
  L.control.zoom({ position: "topright" }).addTo(S.map);
  // the View / Basemap button sits right below the zoom buttons
  const ViewControl = L.Control.extend({
    onAdd() {
      const el = $("#viewctl");
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      return el;
    },
  });
  new ViewControl({ position: "topright" }).addTo(S.map);
  window.addEventListener("resize", () => { S.map.invalidateSize(); if (S.mini) { S.mini.invalidateSize(); fitMinimap(); renderMinimap(); } });

  // place labels sit above the score layer so names stay readable at any opacity
  const labelPane = S.map.createPane("labels");
  labelPane.style.zIndex = 450; labelPane.style.pointerEvents = "none";
  const esriAttr = "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";
  S.base = {
    dark: [
      L.tileLayer(DARK_BASE, { maxZoom: 18, maxNativeZoom: 16, attribution: DARK_ATTR }),
      L.tileLayer(ESRI + "Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, maxNativeZoom: 16, pane: "labels" }),
    ],
    satellite: [
      L.tileLayer(ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, attribution: esriAttr }),
      L.tileLayer(ESRI + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, pane: "labels" }),
    ],
    terrain: [L.tileLayer(ESRI + "World_Topo_Map/MapServer/tile/{z}/{y}/{x}", { maxZoom: 18, attribution: "Tiles &copy; Esri" })],
  };
  setBasemap("satellite");

  S.map.on("click", (e) => { const p = posAt(e.latlng); if (p >= 0) showDetail(p); });
  S.map.on("mousemove", (e) => showTooltip(e));
  S.map.on("mouseout", () => { $("#tooltip").hidden = true; });

  // white dots = known surface analog sites, white diamonds = known cave / lava-tube analogs
  S.knownLayer = L.layerGroup(S.known.map((k) => (k.kind === "cave"
    ? L.marker([k.lat, k.lon], { icon: L.divIcon({ className: "", html: '<div class="cave-pin"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }) })
    : L.circleMarker([k.lat, k.lon], { radius: 5, color: "#0d1014", weight: 2, fillColor: "#ffffff", fillOpacity: 1 })
  ).bindTooltip(`<b>${esc(k.name)}</b><br>${k.kind === "cave" ? "Known cave analog" : "Known analog site"} · ${esc(k.for)}`))).addTo(S.map);
  S.pinLayer = L.layerGroup().addTo(S.map);
  initMinimap();
}

function setBasemap(name) {
  Object.values(S.base).flat().forEach((l) => S.map.hasLayer(l) && S.map.removeLayer(l));
  S.base[name].forEach((l) => l.addTo(S.map));
  $$("#basemaps button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.basemap === name)));
  if (S.overlay) S.overlay.bringToFront();
}

// ---------- view / basemap popover ----------
function openViewPanel(open) {
  $("#viewctl-panel").hidden = !open;
  $("#viewctl-btn").setAttribute("aria-expanded", String(open));
}
function closeViewPanel() { if (!$("#viewctl-panel").hidden) openViewPanel(false); }

// ---------- minimap ("Fast travel") ----------
function initMinimap() {
  S.mini = L.map("minimap", {
    zoomControl: false, attributionControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, zoomSnap: 0, minZoom: -2, maxZoom: 4, inertia: false,
  });
  // The minimap zoom is fractional and slightly negative, so minZoom must go below 0 or the layer drops its tiles.
  // Zoom-1 tiles drawn at 128 px stay sharp on high-density screens.
  L.tileLayer(DARK_BASE, { noWrap: true, minZoom: -2, tileSize: 128, zoomOffset: 1 }).addTo(S.mini);
  // the minimap uses the dark tiles whatever the main basemap is, so credit them on the main map too
  S.map.attributionControl.addAttribution(DARK_ATTR);
  fitMinimap();
  S.miniView = L.rectangle([[0, 0], [1, 1]], { color: "#e8a33d", weight: 1.5, fillColor: "#e8a33d", fillOpacity: 0.06, interactive: false }).addTo(S.mini);
  S.miniKnown = L.layerGroup().addTo(S.mini);
  S.miniPins = L.layerGroup().addTo(S.mini);
  S.mini.on("click", (e) => S.map.panTo(e.latlng));
  S.map.on("move zoomend", syncMinimap);
  $("#minimap-card").addEventListener("toggle", () => {
    if ($("#minimap-card").open) { S.mini.invalidateSize(); fitMinimap(); renderMinimap(); }
  });
}

// whole world across the card width (zoom may be fractional, e.g. 240 px wide -> zoom ≈ −0.09)
function fitMinimap() {
  if (!S.mini) return;
  const w = S.mini.getSize().x || 240;
  S.mini.setView([0, 0], Math.log2(w / 256), { animate: false });
}

// Keep points inside the visible part of the minimap (it shows roughly ±78° of latitude).
function miniLat(lat) {
  const b = S.mini.getBounds(), m = (b.getNorth() - b.getSouth()) * 0.04;
  return Math.max(b.getSouth() + m, Math.min(b.getNorth() - m, lat));
}

function syncMinimap() {
  if (!S.mini || !S.miniView) return;
  const b = S.map.getBounds();
  const s = miniLat(b.getSouth()), n = miniLat(b.getNorth());
  const w = Math.max(-180, b.getWest()), e = Math.min(180, b.getEast());
  // never smaller than 8 px, so a deep zoom still shows where you are
  const p1 = S.mini.latLngToContainerPoint([n, w]), p2 = S.mini.latLngToContainerPoint([s, e]);
  const c = p1.add(p2).divideBy(2), hw = Math.max(4, (p2.x - p1.x) / 2), hh = Math.max(4, (p2.y - p1.y) / 2);
  S.miniView.setBounds([S.mini.containerPointToLatLng([c.x - hw, c.y - hh]), S.mini.containerPointToLatLng([c.x + hw, c.y + hh])]);
}

function renderMinimap() {
  if (!S.mini || !S.clusters) return;
  S.miniKnown.clearLayers();
  S.known.forEach((k) => L.circleMarker([miniLat(k.lat), k.lon], {
    radius: 2.2, stroke: false, fillColor: "#ffffff", fillOpacity: 0.9, interactive: false,
  }).addTo(S.miniKnown));
  S.miniPins.clearLayers();
  visibleClusters().slice(0, TOP_PINS).forEach((c, i) => {
    L.marker([miniLat(c.lat), c.lon], {
      icon: L.divIcon({ className: "", html: `<div class="mini-pin">${c.rank}</div>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
      keyboard: false, title: `Site ${c.rank}: ${fmtCoord(c.lat, c.lon)}`, zIndexOffset: 1000 - i,
    }).on("click", () => { flyToCell(c.best, 6); showDetail(c.best); }).addTo(S.miniPins);
  });
  syncMinimap();
}

// The score grid is equirectangular (0.5° rows). Web Mercator stretches rows towards the poles, so the canvas
// rows are spaced evenly in Mercator y between ±85.0511° and each one samples the grid row at its latitude.
function renderOverlay() {
  const { nlat, nlon, res } = S.grid, spec = viewSpec();
  const src = new Uint8ClampedArray(nlat * nlon * 4);   // grid colours, row 0 = southernmost
  S.grid.cells.forEach((idx, p) => {
    const v = spec.value(p);
    if (v === null) return;
    const o = idx * 4, [r, g, b] = rampAt(v);
    src[o] = r; src[o + 1] = g; src[o + 2] = b; src[o + 3] = spec.alpha(v);
  });
  const W = nlon, H = 2 * nlon;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H);
  const s32 = new Uint32Array(src.buffer), d32 = new Uint32Array(img.data.buffer);
  const yTop = Math.log(Math.tan(Math.PI / 4 + MERC_LAT * Math.PI / 360));
  for (let r = 0; r < H; r++) {
    const y = yTop * (1 - 2 * (r + 0.5) / H);
    const lat = (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
    const i = Math.floor((lat + 90) / res);
    if (i >= 0 && i < nlat) d32.set(s32.subarray(i * nlon, (i + 1) * nlon), r * W);
  }
  ctx.putImageData(img, 0, 0);
  if (S.overlay) S.map.removeLayer(S.overlay);
  S.overlay = L.imageOverlay(cv.toDataURL(), [[-MERC_LAT, -180], [MERC_LAT, 180]], { opacity: +$("#opacity").value, interactive: false }).addTo(S.map);
  renderBubbles();
  renderLegend(spec);
}

// In "Top sites" view every candidate site also gets a circle (area -> size, score -> colour),
// so sites stay visible at world scale where single 0.5° cells are only a few pixels wide.
function renderBubbles() {
  if (!S.bubbleLayer) S.bubbleLayer = L.layerGroup().addTo(S.map);
  S.bubbleLayer.clearLayers();
  if (S.mode !== "top") return;
  const thr = topThreshold(S.score, SITE_SHARE), span = (S.maxScore - thr) || 1;
  visibleClusters().slice().reverse().forEach((c) => {
    const t = 0.25 + 0.75 * Math.min(1, (c.bestScore - thr) / span);
    L.circleMarker([c.lat, c.lon], {
      radius: Math.min(22, 5 + Math.sqrt(c.areaKm2) / 22),
      color: "#0d1014", weight: 1.5, fillColor: rgbCss(rampAt(t)), fillOpacity: 0.85,
    }).bindTooltip(`Site ${c.rank} · <b>${pct(c.bestScore)}</b> · ${fmt(c.areaKm2)} km²`)
      .on("click", () => showDetail(c.best)).addTo(S.bubbleLayer);
  });
}

function renderLegend(spec) {
  $("#legend-title").textContent = spec.title;
  $("#legend-note").textContent = spec.note;
  $("#legend-scale").innerHTML = spec.classes.map((c) =>
    `<li><span class="sw" style="background:${rgbCss(c.color)}"></span><span class="lbl">${esc(c.label)}</span><span class="rng">${esc(c.range)}</span></li>`).join("");
}

function renderPins() {
  S.pinLayer.clearLayers();
  renderMinimap();
  if (!$("#show-ranks").checked) return;
  visibleClusters().slice(0, TOP_PINS).forEach((c) => {
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: "", html: `<div class="rank-pin">${c.rank}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
      keyboard: false, title: `Site ${c.rank}`,
    }).on("click", () => { flyToCell(c.best, Math.max(S.map.getZoom(), 6)); showDetail(c.best); }).addTo(S.pinLayer);
  });
}

// Centre the cell in the part of the map that the detail panel does not cover.
function flyToCell(p, zoom) {
  const [lat, lon] = cellLatLon(S.grid.cells[p]);
  const shift = S.map.getSize().x > 900 ? 220 : 0;  // half of the 420 px slide-over (plus margin) on wide screens
  const pt = S.map.project([lat, lon], zoom).add([shift, 0]);
  S.map.flyTo(S.map.unproject(pt, zoom), zoom, { duration: 0.8 });
}

function showTooltip(e) {
  const tip = $("#tooltip"), p = posAt(e.latlng);
  if (p < 0) { tip.hidden = true; return; }
  const [lat, lon] = cellLatLon(S.grid.cells[p]);
  let extra = "";
  if (S.mode === "criterion") {
    const c = S.criteria.find((x) => x.id === S.criterion);
    extra = ` · ${esc(c.name)} ${esc(fmtVal(c, S.grid.values[c.id][p]))}`;
  } else if (S.mode === "robustness" && S.robustness) {
    extra = ` · robust ${pct(S.robustness[p])}`;
  } else if (S.mode === "coverage") {
    extra = ` · covers ${S.cover[p]} of ${S.coverN}`;
  }
  tip.innerHTML = `${fmtCoord(lat, lon)} · <b>${pct(S.score[p])}</b> match${extra}`;
  tip.style.left = `${e.containerPoint.x}px`;
  tip.style.top = `${e.containerPoint.y}px`;
  tip.hidden = false;
  // flip to the left of the cursor near the right edge so it never leaves the map
  const flip = e.containerPoint.x + tip.offsetWidth + 24 > S.map.getSize().x;
  tip.style.transform = flip ? "translate(calc(-100% - 14px), -50%)" : "";
}

// ---------- panels ----------
function renderKpis() {
  $("#kpi-best").textContent = pct(S.maxScore);
  $("#kpi-sites").textContent = fmt(S.clusters.length);
  $("#kpi-cells").textContent = fmt(S.grid.cells.length);
}

function renderSites() {
  const list = visibleClusters().slice(0, 25);
  const active = S.selected !== undefined ? S.clusterOf[S.selected] : -1;
  $("#sites").innerHTML = list.map((c) => {
    const robust = S.robustness ? ` · robust ${pct(S.robustness[c.best])}` : "";
    return `<li class="site${c.rank - 1 === active ? " is-active" : ""}" data-p="${c.best}" tabindex="0">
      <span class="site-rank">${String(c.rank).padStart(2, "0")}</span>
      <span class="site-coords">${fmtCoord(c.lat, c.lon)}</span>
      <span class="site-score">${pct(c.bestScore)}</span>
      <span class="site-bar"><i style="width:${(c.bestScore * 100).toFixed(1)}%"></i></span>
      <span class="site-meta">${fmt(c.areaKm2 / 1000, 0)}k km² · mean ${pct(c.mean)}${robust} · ${fmt(c.known.km)} km from ${esc(c.known.name)}</span>
    </li>`;
  }).join("") || `<li class="empty">No sites match these filters.</li>`;
  $$("#sites .site").forEach((li) => {
    const go = () => { const p = +li.dataset.p; flyToCell(p, 6); showDetail(p); };
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

const BODY = { moon: "Moon", mars: "Mars" };
const STATUS = {
  verified: '<span class="badge badge-ok">Verified</span>',
  unverified: '<span class="badge badge-warn">Unverified</span>',
};

function renderTarget() {
  const t = S.target, active = activeCriteria();
  const groups = [...new Set(active.map((c) => c.group))];
  const na = S.criteria.filter((c) => !applicable(c));
  const crits = active.map((c) => {
    const info = targetInfo(c);
    const note = info.outside
      ? `<div class="note">${ICON.warn}<span>Outside Earth's range (${fmtVal(c, info.st.min)} to ${fmtVal(c, info.st.max)}); compared with the closest Earth extreme.</span></div>` : "";
    return `<div class="crit">
      <div class="crit-row"><span class="crit-name"><span class="crit-group">${esc(c.group)}</span>${esc(c.name)}</span><span class="crit-value">${esc(targetText(c, info))}</span></div>
      <p>${esc(c.description)}</p>
      <p class="src">Target: ${esc(c.target_source[t.body] || "—")}<br>Earth: ${esc(c.earth_source)}</p>${note}</div>`;
  }).join("");
  const extra = Object.entries(t.extra || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd class="num">${esc(v)}</dd>`).join("");
  const limits = (t.limits || []).map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.target)}</td><td>${esc(l.earth)}</td></tr>`).join("");
  const naList = na.length ? `<p class="method">Not used for this target (no data or not meaningful): ${esc(na.map((c) => c.name).join(", "))}.</p>` : "";
  const notes = (t.notes_subsurface || []).map((n) => `
    <li class="claim">
      <div class="claim-head">${STATUS[n.status] || ""}</div>
      <p>${esc(n.claim)}</p>
      <p class="src">${esc(n.caveat)}</p>
      <p class="src">Source: ${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.source)}</a>` : esc(n.source)}</p>
    </li>`).join("");
  const linkLabel = t.body === "mars" ? "Mars cave catalog" : t.kind === "subsurface" ? "LROC pit catalog" : "LROC image";
  $("#tab-target").innerHTML = `
    <div class="target-head">
      <h2>${esc(t.name)}</h2>
      <span class="chip">${esc(t.mission)}</span>
    </div>
    <dl class="kv card">
      <dt>Body</dt><dd>${esc(BODY[t.body] || t.body)}</dd>
      <dt>Type</dt><dd>${t.kind === "subsurface" ? "Pit / lava-tube entrance" : "Surface landing site"}</dd>
      <dt>Coordinates</dt><dd class="num">${fmtCoord(t.lat, t.lon)}</dd>
      <dt>Analysis window</dt><dd class="num">${t.window_km} × ${t.window_km} km</dd>
      <dt>Coordinate source</dt><dd>${esc(t.coord_source)}</dd>
    </dl>
    <p class="lede" style="margin-top:12px">${esc(t.notes || "")} ${t.info_url ? `<a href="${esc(t.info_url)}" target="_blank" rel="noopener">${linkLabel}</a>` : ""}</p>
    <h3 class="section-title">Target profile · ${active.length} criteria in ${groups.length} groups</h3>
    ${crits}
    ${naList}
    ${notes ? `<h3 class="section-title">Subsurface refuges · what is established</h3><ul class="claims">${notes}</ul>` : ""}
    <h3 class="section-title">Supporting measurements</h3>
    <dl class="kv card">${extra}</dl>
    <h3 class="section-title">What Earth cannot reproduce</h3>
    <table class="limits"><thead><tr><th>Factor</th><th>${esc(t.name)}</th><th>Earth</th></tr></thead><tbody>${limits}</tbody></table>
    <h3 class="section-title">Method</h3>
    <p class="method">Earth's land is divided into 0.5° cells (about 55 km). Every cell gets the same ${active.length} criteria as the target,
      computed with the same formulas. Each criterion is scored by blending the cell's percentile rank on Earth with the actual
      difference in value. When the target lies beyond anything on Earth (for example −154 °C), it is compared with the closest
      Earth extreme. The total is the weighted mean; missing data lowers it slightly. Candidate sites are connected groups of
      cells in the top ${SITE_SHARE * 100}% of land.</p>`;
}

function renderWeights() {
  const active = activeCriteria();
  const groups = [...new Set(active.map((c) => c.group))];
  $("#weights").innerHTML = groups.map((g) => `
    <div class="weight-group"><h3>${esc(g)}</h3>
    ${active.filter((c) => c.group === g).map((c) => `
      <div class="weight">
        <div class="weight-top"><label for="w-${c.id}">${esc(c.name)}</label><output id="wv-${c.id}">${fmt(S.weights[c.id], 1)}</output></div>
        <input type="range" id="w-${c.id}" min="0" max="2" step="0.1" value="${S.weights[c.id]}" data-id="${c.id}">
        <p>${esc(c.why)}</p>
      </div>`).join("")}</div>`).join("");
  let timer;
  $$("#weights input").forEach((el) => el.addEventListener("input", () => {
    S.weights[el.dataset.id] = +el.value;
    $(`#wv-${el.dataset.id}`).textContent = fmt(+el.value, 1);
    if (S.problem !== "custom") { S.problem = "custom"; if (S.mode === "coverage") { S.mode = "similarity"; syncModeButtons(); } renderSetup(); }
    clearTimeout(timer); timer = setTimeout(recompute, 150);
  }));
}

function showDetail(p) {
  S.selected = p;
  const K = S.criteria.length, idx = S.grid.cells[p], [lat, lon] = cellLatLon(idx), t = S.target;
  const known = nearestKnown(lat, lon), ci = S.clusterOf[p], cluster = ci >= 0 ? S.clusters[ci] : null;
  const like = [], unlike = [];
  let missing = 0;
  const rows = S.criteria.map((c, k) => {
    if (!applicable(c)) return "";
    const x = S.grid.values[c.id][p], s = S.sub[p * K + k], info = targetInfo(c);
    if (Number.isNaN(s)) missing++;
    else if (S.weights[c.id] > 0) { if (s >= 0.7) like.push(c.name); else if (s < 0.35) unlike.push(c.name); }
    const clampNote = info.outside ? `<div class="src" style="color:var(--ink-3);font-size:11.5px">vs. Earth extreme ${esc(fmtVal(c, info.clamped))}</div>` : "";
    const bar = Number.isNaN(s) ? `<span style="color:var(--ink-3)">no data</span>` :
      `${pct(s)}<div class="meter"><i style="width:${s * 100}%;background:${scoreInk(s)}"></i></div>`;
    return `<tr><td>${esc(c.name)}${S.weights[c.id] === 0 ? ' <span style="color:var(--ink-3)">(weight 0)</span>' : ""}</td>
      <td class="num">${esc(fmtVal(c, x))}</td><td class="num">${esc(targetText(c, info))}${clampNote}</td><td class="num">${bar}</td></tr>`;
  }).join("");
  const wv = `https://worldview.earthdata.nasa.gov/?v=${lon - 2},${lat - 1.5},${lon + 2},${lat + 1.5}`;
  const osm = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=8/${lat}/${lon}`;
  const el = $("#detail");
  el.innerHTML = `
    <button class="detail-close" type="button" aria-label="Close details">${ICON.close}</button>
    <div class="eyebrow">${cluster ? `Candidate site ${cluster.rank} of ${S.clusters.length}` : "0.5° grid cell"}</div>
    <h2>${fmtCoord(lat, lon)}</h2>
    <div class="score-row"><span class="score-big">${pct(S.score[p])}</span><span class="score-of">similarity to ${esc(t.name)}</span></div>
    <div class="facts">
      <div class="fact"><span>Nearest known analog</span><b>${fmt(known.km)} km</b><span>${esc(known.name)}</span></div>
      <div class="fact"><span>${cluster ? "Site area" : "Cell area"}</span><b>${cluster ? `${fmt(cluster.areaKm2)} km²` : `${fmt(3091 * Math.cos(lat * Math.PI / 180))} km²`}</b>
        <span>${S.robustness ? `robust in ${pct(S.robustness[p])} of runs` : missing ? `${missing} criteria without data` : "all criteria have data"}</span></div>
    </div>
    <div class="verdict">
      <div class="verdict-row">${ICON.check}<span><span class="lbl">Matches on:</span> ${like.length ? esc(like.join(", ")) : "—"}</span></div>
      <div class="verdict-row">${ICON.cross}<span><span class="lbl">Differs on:</span> ${unlike.length ? esc(unlike.join(", ")) : "—"}</span></div>
    </div>
    <h3 class="section-title">By test problem</h3>
    <div class="pbars">${coverIds().map((id) => { const r = S.pr[id], s = r.score[p]; return `
      <div class="pbar"><span>${esc(problemById(id).name)}</span><span class="meter"><i style="width:${s * 100}%;background:${scoreInk(s)}"></i></span>
      <span class="num">${pct(s)}</span>${s >= r.thr ? '<span class="badge badge-ok">top 5%</span>' : "<span></span>"}</div>`; }).join("")}</div>
    <h3 class="section-title">By criterion</h3>
    <table class="cmp"><thead><tr><th>Criterion</th><th>Here</th><th>${esc(t.name)}</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>
    <h3 class="section-title">What Earth cannot reproduce</h3>
    <table class="limits"><tbody>${(t.limits || []).map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.target)}</td><td>${esc(l.earth)}</td></tr>`).join("")}</tbody></table>
    <div class="links"><a href="${wv}" target="_blank" rel="noopener">Open in NASA Worldview</a><a href="${osm}" target="_blank" rel="noopener">OpenStreetMap</a></div>`;
  el.hidden = false;
  el.querySelector(".detail-close").onclick = closeDetail;
  if (S.selMarker) S.map.removeLayer(S.selMarker);
  const h = S.grid.res / 2;
  S.selMarker = L.rectangle([[lat - h, lon - h], [lat + h, lon + h]], { color: "#e8a33d", weight: 2, fill: false, interactive: false }).addTo(S.map);
  $$("#sites .site").forEach((li) => li.classList.toggle("is-active", ci >= 0 && S.clusterOf[+li.dataset.p] === ci));
}

function closeDetail() {
  $("#detail").hidden = true;
  if (S.selMarker) S.map.removeLayer(S.selMarker);
  S.selected = undefined;
  $$("#sites .site").forEach((li) => li.classList.remove("is-active"));
}

// ---------- controls ----------
function setMode(mode) {
  S.mode = mode;
  if (S.problem === "combined") { S.problem = "all"; renderSetup(); }
  syncModeButtons();
  if (mode === "robustness" && !S.robustness) {
    $("#loading").hidden = false;
    $("#loading span").textContent = `Re-scoring the planet with ${ROBUST_RUNS} random weightings…`;
    setTimeout(() => { computeRobustness(); $("#loading").hidden = true; renderOverlay(); renderSites(); if (S.selected !== undefined) showDetail(S.selected); }, 30);
    return;
  }
  renderOverlay();
}

function selectTarget(id) {
  S.target = S.targets.find((t) => t.id === id);
  S.body = S.target.body;
  if (!S.criteria.some((c) => c.scenario && (!c.bodies || c.bodies.includes(S.body)))) S.scenario = "normal";
  const active = activeCriteria();
  if (!active.some((c) => c.id === S.criterion)) S.criterion = active[0].id;
  $("#criterion").innerHTML = active.map((c) => `<option value="${c.id}">${esc(c.group)} · ${esc(c.name)}</option>`).join("");
  $("#criterion").value = S.criterion;
  computeSub();
  computeProblems();
  // keep the chosen test problem when the new target supports it, otherwise fall back to the full match
  const keep = S.problem === "combined" ? S.coverN > 1 : S.problem !== "custom" && problemOk(problemById(S.problem));
  if (!keep) { S.problem = "all"; if (S.mode === "coverage") S.mode = "similarity"; }
  S.weights = problemWeights(problemById(S.problem === "combined" ? "all" : S.problem));
  syncModeButtons();
  renderSetup();
  renderTarget();
  renderWeights();
  recompute();
  if (S.view === "docs" && window.renderDocs) window.renderDocs();
}

async function load() {
  const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p); return r.json(); });
  const [grid, criteria, targets, known] = await Promise.all([
    get("data/earth_grid.json"), get("data/criteria.json"), get("data/targets.json"), get("data/known_analogs.json"),
  ]);
  // one shared set of group names, whatever the pipeline module called them
  const GROUP = {
    t_mean: "Temperature", t_max: "Temperature", t_swing: "Temperature", low_sun: "Light and shadow",
    precip: "Water and ice", ice: "Water and ice", pressure: "Atmosphere",
  };
  const ORDER = ["Terrain", "Light and shadow", "Temperature", "Atmosphere", "Water and ice", "Surface and minerals", "Life", "Subsurface"];
  criteria.forEach((c) => { c.group = GROUP[c.id] || c.group; });
  criteria.sort((a, b) => (ORDER.indexOf(a.group) + 99) % 99 - (ORDER.indexOf(b.group) + 99) % 99);
  Object.assign(S, { grid, criteria, targets, known });
  S.posOf = new Int32Array(grid.nlat * grid.nlon).fill(-1);
  grid.cells.forEach((c, p) => { S.posOf[c] = p; });
  criteria.forEach((c) => { S.weights[c.id] = c.weight; });
  S.criterion = criteria[0].id;
}

(async function main() {
  const css = getComputedStyle(document.documentElement);
  RAMP = [0, 1, 2, 3, 4, 5].map((k) => hexToRgb(css.getPropertyValue(`--seq-${k}`)));
  try {
    await load();
  } catch (e) {
    $("#loading span").textContent = `Could not load data (${e.message}). Run the scripts in pipeline/ and serve the app folder over HTTP.`;
    $(".loading-bar").hidden = true;
    return;
  }
  initMap();
  $("#target").onchange = (e) => selectTarget(e.target.value);
  $("#bodies").addEventListener("click", (e) => {
    const b = e.target.closest("[data-body]");
    if (b && b.dataset.body !== S.body) selectTarget(S.targets.find((t) => t.body === b.dataset.body).id);
  });
  $("#problems").addEventListener("click", (e) => { const b = e.target.closest("[data-problem]"); if (b && !b.disabled) setProblem(b.dataset.problem); });
  $("#storm").addEventListener("click", () => setScenario(S.scenario === "storm" ? "normal" : "storm"));
  initTestsCollapse();
  $$(".mainnav button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("#criterion").onchange = (e) => { S.criterion = e.target.value; renderOverlay(); };
  $("#top-share").onchange = (e) => { S.topShare = +e.target.value; renderOverlay(); };
  $$("#basemaps button").forEach((b) => b.addEventListener("click", () => setBasemap(b.dataset.basemap)));
  $("#viewctl-btn").addEventListener("click", () => openViewPanel($("#viewctl-panel").hidden));
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#viewctl")) closeViewPanel(); });
  $("#opacity").oninput = (e) => S.overlay && S.overlay.setOpacity(+e.target.value);
  $$("#view-modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $$(".tab").forEach((t) => { t.hidden = t.id !== b.dataset.tab; });
  }));
  $("#reset-weights").onclick = () => setProblem("all");
  $("#only-new").onchange = () => { renderSites(); renderPins(); renderBubbles(); };
  $("#show-ranks").onchange = renderPins;
  $("#show-known").onchange = (e) => (e.target.checked ? S.knownLayer.addTo(S.map) : S.map.removeLayer(S.knownLayer));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#viewctl-panel").hidden) { closeViewPanel(); $("#viewctl-btn").focus(); } else if (!$("#detail").hidden) closeDetail();
  });
  // a short map has no room for both the legend (top-left) and the minimap (bottom-left)
  if (window.matchMedia("(max-width: 560px)").matches || $(".map-wrap").clientHeight < 520) $("#legend").open = false;
  S.target = S.targets[0];
  selectTarget(S.targets[0].id);
  $("#loading").hidden = true;
  // deep links: #method opens the Method and data page; #at=lat,lon,zoom positions the map
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash === "method") setView("docs");
  const at = /^at=(-?[\d.]+),(-?[\d.]+),(\d+(?:\.\d+)?)$/.exec(hash);
  if (at) S.map.setView([+at[1], +at[2]], +at[3], { animate: false });
})();
