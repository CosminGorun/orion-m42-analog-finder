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
  const clamped = Math.max(st.min, Math.min(st.max, t));
  return { t, clamped, outside: t < st.min || t > st.max, st };
}

// Criterion score = geometric mean of (a) closeness in percentile rank and (b) closeness in actual value,
// so 2,600 m and 5,300 m of relief are not treated as equal just because both sit in Earth's top 1%.
function computeSub() {
  const n = S.grid.cells.length, K = S.criteria.length;
  S.sub = new Float32Array(n * K);
  S.criteria.forEach((c, k) => {
    const vals = S.grid.values[c.id], info = targetInfo(c);
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
  const w = S.criteria.map((c) => weights[c.id]);
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
    const w = {}; S.criteria.forEach((c) => { w[c.id] = Math.random() * 2; });
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
function initMap() {
  // Geographic projection used by NASA GIBS (EPSG:4326, 512 px tiles)
  const crs = L.extend({}, L.CRS.EPSG4326, {
    transformation: new L.Transformation(1, 180, -1, 90),
    scale: (z) => Math.pow(2, z) / 0.5625,
    zoom: (s) => Math.log(s * 0.5625) / Math.LN2,
  });
  const bounds = [[-90, -180], [90, 180]];
  // loose pan limits so sites near the date line or the poles can still be centred beside the detail panel
  S.map = L.map("map", { crs, center: [0, 0], zoom: 1, minZoom: 0, maxZoom: 7, maxBounds: [[-110, -240], [110, 240]], zoomSnap: 0.25, zoomControl: false });
  L.control.zoom({ position: "topright" }).addTo(S.map);
  S.map.fitBounds(bounds, { padding: [4, 4] });
  window.addEventListener("resize", () => S.map.invalidateSize());
  const gibs = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/";
  const opts = { tileSize: 512, bounds, noWrap: true };
  // coastlines sit above the score layer so shapes stay readable at any opacity
  const coastPane = S.map.createPane("coast");
  coastPane.style.zIndex = 450; coastPane.style.pointerEvents = "none";
  const attr = 'Basemap: <a href="https://nasa-gibs.github.io/gibs-api-docs/">NASA GIBS</a>';
  S.base = {
    satellite: [L.tileLayer(gibs + "BlueMarble_ShadedRelief_Bathymetry/default/2004-08-01/500m/{z}/{y}/{x}.jpeg", { ...opts, maxNativeZoom: 7, attribution: attr + " Blue Marble" })],
    relief: [
      L.tileLayer(gibs + "ASTER_GDEM_Greyscale_Shaded_Relief/default/2004-08-01/31.25m/{z}/{y}/{x}.jpg", { ...opts, maxNativeZoom: 7, attribution: attr + " ASTER GDEM shaded relief", className: "relief-tiles" }),
      L.tileLayer(gibs + "Coastlines_15m/default/2004-08-01/15.625m/{z}/{y}/{x}.png", { ...opts, maxNativeZoom: 7, pane: "coast", opacity: 0.6 }),
    ],
    dark: [L.tileLayer(gibs + "Coastlines_15m/default/2004-08-01/15.625m/{z}/{y}/{x}.png", { ...opts, maxNativeZoom: 7, pane: "coast", className: "coast-dark", attribution: attr + " coastlines" })],
  };
  setBasemap("dark");

  S.map.on("click", (e) => { const p = posAt(e.latlng); if (p >= 0) showDetail(p); });
  S.map.on("mousemove", (e) => showTooltip(e));
  S.map.on("mouseout", () => { $("#tooltip").hidden = true; });

  S.knownLayer = L.layerGroup(S.known.map((k) => L.circleMarker([k.lat, k.lon], {
    radius: 5, color: "#0d1014", weight: 2, fillColor: "#ffffff", fillOpacity: 1,
  }).bindTooltip(`<b>${esc(k.name)}</b><br>Known analog site · ${esc(k.for)}`))).addTo(S.map);
  S.pinLayer = L.layerGroup().addTo(S.map);
}

function setBasemap(name) {
  Object.values(S.base).flat().forEach((l) => S.map.hasLayer(l) && S.map.removeLayer(l));
  S.base[name].forEach((l) => l.addTo(S.map));
  if (S.overlay) S.overlay.bringToFront();
}

function renderOverlay() {
  const { nlat, nlon } = S.grid, spec = viewSpec();
  const cv = document.createElement("canvas"); cv.width = nlon; cv.height = nlat;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(nlon, nlat);
  S.grid.cells.forEach((idx, p) => {
    const v = spec.value(p);
    if (v === null) return;
    const i = Math.floor(idx / nlon), j = idx % nlon, o = ((nlat - 1 - i) * nlon + j) * 4, [r, g, b] = rampAt(v);
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = spec.alpha(v);
  });
  ctx.putImageData(img, 0, 0);
  if (S.overlay) S.map.removeLayer(S.overlay);
  S.overlay = L.imageOverlay(cv.toDataURL(), [[-90, -180], [90, 180]], { opacity: +$("#opacity").value, interactive: false }).addTo(S.map);
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
  if (!$("#show-ranks").checked) return;
  visibleClusters().slice(0, TOP_PINS).forEach((c) => {
    L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: "", html: `<div class="rank-pin">${c.rank}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
      keyboard: false, title: `Site ${c.rank}`,
    }).on("click", () => { flyToCell(c.best, Math.max(S.map.getZoom(), 4)); showDetail(c.best); }).addTo(S.pinLayer);
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
    const go = () => { const p = +li.dataset.p; flyToCell(p, 4.5); showDetail(p); };
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

function renderTarget() {
  const t = S.target;
  const groups = [...new Set(S.criteria.map((c) => c.group))];
  const crits = S.criteria.map((c) => {
    const info = targetInfo(c);
    const note = info.outside
      ? `<div class="note">${ICON.warn}<span>Outside Earth's range (${fmtVal(c, info.st.min)} to ${fmtVal(c, info.st.max)}); compared with the closest Earth extreme.</span></div>` : "";
    return `<div class="crit">
      <div class="crit-row"><span class="crit-name"><span class="crit-group">${esc(c.group)}</span>${esc(c.name)}</span><span class="crit-value">${esc(fmtVal(c, info.t))}</span></div>
      <p>${esc(c.description)}</p>
      <p class="src">Target: ${esc(c.target_source[t.body] || "—")}<br>Earth: ${esc(c.earth_source)}</p>${note}</div>`;
  }).join("");
  const extra = Object.entries(t.extra || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd class="num">${esc(v)}</dd>`).join("");
  const limits = (t.limits || []).map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.target)}</td><td>${esc(l.earth)}</td></tr>`).join("");
  $("#tab-target").innerHTML = `
    <div class="target-head">
      <h2>${esc(t.name)}</h2>
      <span class="chip">${esc(t.mission)}</span>
    </div>
    <dl class="kv card">
      <dt>Body</dt><dd>${t.body === "moon" ? "Moon" : esc(t.body)}</dd>
      <dt>Coordinates</dt><dd class="num">${fmtCoord(t.lat, t.lon)}</dd>
      <dt>Analysis window</dt><dd class="num">${t.window_km} × ${t.window_km} km</dd>
      <dt>Coordinate source</dt><dd>${esc(t.coord_source)}</dd>
    </dl>
    <p class="lede" style="margin-top:12px">${esc(t.notes || "")} ${t.info_url ? `<a href="${esc(t.info_url)}" target="_blank" rel="noopener">LROC image</a>` : ""}</p>
    <h3 class="section-title">Target profile · ${S.criteria.length} criteria in ${groups.length} groups</h3>
    ${crits}
    <h3 class="section-title">Supporting measurements</h3>
    <dl class="kv card">${extra}</dl>
    <h3 class="section-title">What Earth cannot reproduce</h3>
    <table class="limits"><thead><tr><th>Factor</th><th>${esc(t.name)}</th><th>Earth</th></tr></thead><tbody>${limits}</tbody></table>
    <h3 class="section-title">Method</h3>
    <p class="method">Earth's land is divided into 0.5° cells (about 55 km). Every cell gets the same ${S.criteria.length} criteria as the target,
      computed with the same formulas. Each criterion is scored by blending the cell's percentile rank on Earth with the actual
      difference in value. When the target lies beyond anything on Earth (for example −154 °C), it is compared with the closest
      Earth extreme. The total is the weighted mean; missing data lowers it slightly. Candidate sites are connected groups of
      cells in the top ${SITE_SHARE * 100}% of land.</p>`;
}

function renderWeights() {
  const groups = [...new Set(S.criteria.map((c) => c.group))];
  $("#weights").innerHTML = groups.map((g) => `
    <div class="weight-group"><h3>${esc(g)}</h3>
    ${S.criteria.filter((c) => c.group === g).map((c) => `
      <div class="weight">
        <div class="weight-top"><label for="w-${c.id}">${esc(c.name)}</label><output id="wv-${c.id}">${fmt(S.weights[c.id], 1)}</output></div>
        <input type="range" id="w-${c.id}" min="0" max="2" step="0.1" value="${S.weights[c.id]}" data-id="${c.id}">
        <p>${esc(c.why)}</p>
      </div>`).join("")}</div>`).join("");
  let timer;
  $$("#weights input").forEach((el) => el.addEventListener("input", () => {
    S.weights[el.dataset.id] = +el.value;
    $(`#wv-${el.dataset.id}`).textContent = fmt(+el.value, 1);
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
    const x = S.grid.values[c.id][p], s = S.sub[p * K + k], info = targetInfo(c);
    if (Number.isNaN(s)) missing++;
    else if (S.weights[c.id] > 0) { if (s >= 0.7) like.push(c.name); else if (s < 0.35) unlike.push(c.name); }
    const clampNote = info.outside ? `<div class="src" style="color:var(--ink-3);font-size:11.5px">vs. Earth extreme ${esc(fmtVal(c, info.clamped))}</div>` : "";
    const bar = Number.isNaN(s) ? `<span style="color:var(--ink-3)">no data</span>` :
      `${pct(s)}<div class="meter"><i style="width:${s * 100}%;background:${scoreInk(s)}"></i></div>`;
    return `<tr><td>${esc(c.name)}${S.weights[c.id] === 0 ? ' <span style="color:var(--ink-3)">(weight 0)</span>' : ""}</td>
      <td class="num">${esc(fmtVal(c, x))}</td><td class="num">${esc(fmtVal(c, info.t))}${clampNote}</td><td class="num">${bar}</td></tr>`;
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
  $$("#view-modes button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
  $("#criterion-field").hidden = mode !== "criterion";
  $("#top-field").hidden = mode !== "top";
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
  computeSub();
  renderTarget();
  recompute();
}

async function load() {
  const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p); return r.json(); });
  const [grid, criteria, targets, known] = await Promise.all([
    get("data/earth_grid.json"), get("data/criteria.json"), get("data/targets.json"), get("data/known_analogs.json"),
  ]);
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
  $("#target").innerHTML = S.targets.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  $("#target").onchange = (e) => selectTarget(e.target.value);
  $("#criterion").innerHTML = S.criteria.map((c) => `<option value="${c.id}">${esc(c.group)} · ${esc(c.name)}</option>`).join("");
  $("#criterion").onchange = (e) => { S.criterion = e.target.value; renderOverlay(); };
  $("#top-share").onchange = (e) => { S.topShare = +e.target.value; renderOverlay(); };
  $("#basemap").onchange = (e) => setBasemap(e.target.value);
  $("#opacity").oninput = (e) => S.overlay && S.overlay.setOpacity(+e.target.value);
  $$("#view-modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $$(".tab").forEach((t) => { t.hidden = t.id !== b.dataset.tab; });
  }));
  $("#reset-weights").onclick = () => { S.criteria.forEach((c) => { S.weights[c.id] = c.weight; }); renderWeights(); recompute(); };
  $("#only-new").onchange = () => { renderSites(); renderPins(); renderBubbles(); };
  $("#show-ranks").onchange = renderPins;
  $("#show-known").onchange = (e) => (e.target.checked ? S.knownLayer.addTo(S.map) : S.map.removeLayer(S.knownLayer));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#detail").hidden) closeDetail(); });
  if (window.matchMedia("(max-width: 560px)").matches) $("#legend").open = false;
  renderWeights();
  selectTarget(S.targets[0].id);
  $("#loading").hidden = true;
})();
