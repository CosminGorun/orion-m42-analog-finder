/* Analog Finder – prototip.
 * Datele vin din app/data/*.json, generate de scripturile din pipeline/.
 * Scorurile se calculează aici, în browser, ca ponderile să poată fi schimbate pe loc.
 */
"use strict";

const SHARP = 6;            // cât de repede scade scorul unui criteriu când celula se depărtează de țintă
const TOP_FRACTION = 0.01;  // zonele „găsite” = primul 1% din celulele de uscat
const NEW_KM = 300;         // „loc nou” = mai departe de atât de orice analog cunoscut
const STAB_RUNS = 300;

const S = {
  grid: null, criteria: [], targets: [], known: [],
  target: null, weights: {}, posOf: null, sub: null, cover: null,
  score: null, stability: null, clusters: [], map: null, overlay: null,
  knownLayer: null, selMarker: null,
};

// ---------- utilitare ----------
const $ = (s) => document.querySelector(s);
const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v)) ? "—" :
  Number(v).toLocaleString("ro-RO", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v) => `${Math.round(v * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function viridis(t) {
  const stops = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(Math.floor(t), stops.length - 2), f = t - i;
  return stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
}
function scoreColor(s) { return s >= 0.7 ? "var(--good)" : s >= 0.4 ? "var(--mid)" : "var(--bad)"; }

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function cellLatLon(idx) {
  const { res, nlon } = S.grid, i = Math.floor(idx / nlon), j = idx % nlon;
  return [-90 + (i + 0.5) * res, -180 + (j + 0.5) * res];
}

function nearestKnown(lat, lon) {
  let best = null;
  for (const k of S.known) {
    const d = haversineKm(lat, lon, k.lat, k.lon);
    if (!best || d < best.km) best = { ...k, km: d };
  }
  return best;
}

// Percentila unei valori în distribuția de pe Pământ (0..1), tratând corect platourile (ex. multe zerouri).
function rankFn(q) {
  const n = q.length - 1;
  return (x) => {
    if (x <= q[0]) return x < q[0] ? 0 : (upper(q, x)) / 2 / n;
    if (x >= q[n]) return x > q[n] ? 1 : (lower(q, x) + n) / 2 / n;
    const lo = lower(q, x), hi = upper(q, x);
    if (hi >= lo) return (lo + hi) / 2 / n;                 // x cade pe un platou
    const f = (x - q[hi]) / (q[lo] - q[hi] || 1);           // aici hi = lo - 1
    return (hi + f) / n;
  };
}
function lower(q, x) { let a = 0, b = q.length; while (a < b) { const m = (a + b) >> 1; q[m] < x ? a = m + 1 : b = m; } return a; }
function upper(q, x) { let a = 0, b = q.length; while (a < b) { const m = (a + b) >> 1; q[m] <= x ? a = m + 1 : b = m; } return a - 1; }

// ---------- încărcare ----------
async function load() {
  const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p); return r.json(); });
  const [grid, criteria, targets, known] = await Promise.all([
    get("data/earth_grid.json"), get("data/criteria.json"),
    get("data/targets.json"), get("data/known_analogs.json"),
  ]);
  Object.assign(S, { grid, criteria, targets, known });
  S.posOf = new Int32Array(grid.nlat * grid.nlon).fill(-1);
  grid.cells.forEach((c, p) => { S.posOf[c] = p; });
  criteria.forEach((c) => { S.weights[c.id] = c.weight; });
}

// ---------- calcul ----------
function targetInfo(c) {
  const t = S.target.values[c.id], st = S.grid.stats[c.id];
  const clamped = Math.max(st.min, Math.min(st.max, t));
  return { t, clamped, outside: t < st.min || t > st.max, st };
}

function computeSub() {
  const n = S.grid.cells.length, K = S.criteria.length;
  S.sub = new Float32Array(n * K);
  S.criteria.forEach((c, k) => {
    const vals = S.grid.values[c.id], info = targetInfo(c);
    if (c.binary) {
      for (let p = 0; p < n; p++) {
        const x = vals[p];
        S.sub[p * K + k] = x === null ? NaN : (x === info.clamped ? 1 : 0);
      }
      return;
    }
    // Scor = media geometrică dintre:
    //  - apropierea în percentile (cât de rar/comun e terenul pe Pământ) și
    //  - apropierea în valoare reală (ca 2.600 m să nu pară egal cu 5.300 m doar pentru că ambele sunt în top 1%).
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

// Scor total = media ponderată a criteriilor disponibile, penalizată ușor când lipsesc date.
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

function topThreshold(score, frac) {
  const bins = new Uint32Array(1001);
  for (const s of score) bins[Math.min(1000, Math.floor(s * 1000))]++;
  let need = Math.ceil(score.length * frac);
  for (let b = 1000; b >= 0; b--) { need -= bins[b]; if (need <= 0) return b / 1000; }
  return 0;
}

function buildClusters() {
  const { nlat, nlon } = S.grid, thr = topThreshold(S.score, TOP_FRACTION);
  const seen = new Uint8Array(S.score.length), clusters = [];
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
      known: nearestKnown(lat, lon),
    });
  }
  clusters.sort((a, b) => b.bestScore - a.bestScore);
  S.clusters = clusters;
}

function recompute() {
  S.score = scoreAll(S.weights, S.score || new Float32Array(S.grid.cells.length));
  S.stability = null;
  $("#stability-note").textContent = "";
  buildClusters();
  renderOverlay();
  renderZones();
  if (S.selected !== undefined) showDetail(S.selected);
}

// ---------- hartă ----------
function initMap() {
  // Proiecția geografică folosită de NASA GIBS (EPSG:4326, tile-uri de 512 px)
  const crs = L.extend({}, L.CRS.EPSG4326, {
    transformation: new L.Transformation(1, 180, -1, 90),
    scale: (z) => Math.pow(2, z) / 0.5625,
    zoom: (s) => Math.log(s * 0.5625) / Math.LN2,
  });
  const bounds = [[-90, -180], [90, 180]];
  S.map = L.map("map", { crs, center: [10, 0], zoom: 1, minZoom: 0, maxZoom: 7, maxBounds: bounds, worldCopyJump: false });
  const gibs = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/";
  L.tileLayer(gibs + "BlueMarble_ShadedRelief_Bathymetry/default/2004-08-01/500m/{z}/{y}/{x}.jpeg", {
    tileSize: 512, bounds, noWrap: true, maxNativeZoom: 7,
    attribution: 'Hartă de bază: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a> Blue Marble',
  }).addTo(S.map);
  S.labels = L.tileLayer(gibs + "Reference_Labels_15m/default/2004-08-01/15.625m/{z}/{y}/{x}.png", {
    tileSize: 512, bounds, noWrap: true, maxNativeZoom: 13, zIndex: 650, pane: "overlayPane",
  });
  S.map.on("click", (e) => {
    const { res, nlon } = S.grid;
    const i = Math.floor((e.latlng.lat + 90) / res), j = Math.floor((e.latlng.lng + 180) / res);
    const p = S.posOf[i * nlon + j];
    if (p >= 0) showDetail(p);
  });
  S.knownLayer = L.layerGroup(S.known.map((k) => L.circleMarker([k.lat, k.lon], {
    radius: 5, color: "#111", weight: 2, fillColor: "#fff", fillOpacity: 1,
  }).bindTooltip(`<b>${esc(k.name)}</b><br>Analog cunoscut: ${esc(k.for)}`))).addTo(S.map);
}

function renderOverlay() {
  const { nlat, nlon } = S.grid;
  const cv = document.createElement("canvas"); cv.width = nlon; cv.height = nlat;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(nlon, nlat);
  // Culoarea e relativă la cea mai bună celulă, ca diferențele să se vadă; scorul absolut apare la click.
  let max = 0; for (const s of S.score) if (s > max) max = s;
  S.maxScore = max || 1;
  S.grid.cells.forEach((idx, p) => {
    const t = S.score[p] / S.maxScore, i = Math.floor(idx / nlon), j = idx % nlon;
    const o = ((nlat - 1 - i) * nlon + j) * 4, [r, g, b] = viridis(t);
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b;
    img.data[o + 3] = t < 0.35 ? 25 : Math.round(90 + 140 * (t - 0.35) / 0.65);
  });
  $(".legend .ticks").innerHTML = `<span>0%</span><span>${pct(S.maxScore)} (maxim)</span>`;
  ctx.putImageData(img, 0, 0);
  if (S.overlay) S.map.removeLayer(S.overlay);
  S.overlay = L.imageOverlay(cv.toDataURL(), [[-90, -180], [90, 180]], { opacity: 0.75, interactive: false }).addTo(S.map);
}

// ---------- panouri ----------
function renderTarget() {
  const t = S.target;
  const rows = S.criteria.map((c) => {
    const info = targetInfo(c);
    const val = c.binary ? (info.t ? "da" : "nu") : `${fmt(info.t, c.decimals)} ${c.unit}`;
    const warn = info.outside
      ? `<div class="warn">⚠ În afara domeniului de pe Pământ (${fmt(info.st.min, c.decimals)} … ${fmt(info.st.max, c.decimals)} ${c.unit}). Se compară cu extrema cea mai apropiată.</div>` : "";
    return `<div class="crit">
      <div class="row"><span class="name"><span class="tag">${esc(c.group)}</span>${esc(c.name)}</span><span class="val">${val}</span></div>
      <div class="src">${esc(c.description)}</div>
      <div class="src">Sursă țintă: ${esc(c.target_source[t.body] || "—")}</div>
      <div class="src">Sursă Pământ: ${esc(c.earth_source)}</div>${warn}</div>`;
  }).join("");
  const extra = Object.entries(t.extra || {}).map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join("");
  const limits = (t.limits || []).map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.target)}</td><td>${esc(l.earth)}</td></tr>`).join("");
  $("#t-target").innerHTML = `
    <h2>${esc(t.name)}</h2>
    <p class="hint">${esc(t.mission)}</p>
    <div class="card kv">
      <span class="k">Corp ceresc</span><span class="v">${t.body === "moon" ? "Luna" : esc(t.body)}</span>
      <span class="k">Coordonate</span><span class="v">${fmt(t.lat, 2)}°, ${fmt(t.lon, 2)}°E</span>
      <span class="k">Fereastră analizată</span><span class="v">${t.window_km} × ${t.window_km} km</span>
      <span class="k">Sursa coordonatelor</span><span class="v">${esc(t.coord_source)}</span>
    </div>
    <p>${esc(t.notes || "")} ${t.info_url ? `<a href="${esc(t.info_url)}" target="_blank" rel="noopener">Imagine LROC ↗</a>` : ""}</p>
    <h3>Profilul țintei (${S.criteria.length} criterii)</h3>
    ${rows}
    <h3>Date suplimentare</h3>
    <div class="card kv">${extra}</div>
    <h3>Ce nu se poate reproduce pe Pământ</h3>
    <table class="cmp"><tr><th>Factor</th><th>${esc(t.name)}</th><th>Pământ</th></tr>${limits}</table>
    <h3>Metodă</h3>
    <p class="hint">Pământul e împărțit în celule de 0,5° (~55 km). Pentru fiecare celulă se calculează aceleași
      ${S.criteria.length} criterii ca pentru țintă, cu aceleași formule. Fiecare criteriu primește un scor care combină
      (1) cât de aproape e celula de țintă în distribuția valorilor de pe Pământ (percentile) și (2) cât de aproape e valoarea
      reală. Când ținta e în afara a tot ce există pe Pământ (ex. −154 °C), se compară cu extrema terestră cea mai apropiată.
      Scorul total e media ponderată; criteriile fără date scad ușor scorul. Zonele găsite sunt grupurile de celule vecine
      din primul ${TOP_FRACTION * 100}% al scorurilor.</p>`;
}

function renderWeights() {
  $("#weights").innerHTML = S.criteria.map((c) => `
    <div class="weight">
      <label for="w-${c.id}"><span>${esc(c.name)}</span><span id="wv-${c.id}">${fmt(S.weights[c.id], 1)}</span></label>
      <input type="range" id="w-${c.id}" min="0" max="2" step="0.1" value="${S.weights[c.id]}" data-id="${c.id}">
      <p>${esc(c.why)}</p>
    </div>`).join("");
  let timer;
  $("#weights").querySelectorAll("input").forEach((el) => el.addEventListener("input", () => {
    S.weights[el.dataset.id] = +el.value;
    $(`#wv-${el.dataset.id}`).textContent = fmt(+el.value, 1);
    clearTimeout(timer); timer = setTimeout(recompute, 150);
  }));
}

function renderZones() {
  const onlyNew = $("#only-new").checked;
  const list = S.clusters.filter((c) => !onlyNew || c.known.km > NEW_KM).slice(0, 20);
  $("#zones").innerHTML = list.map((c) => {
    const stab = S.stability ? ` · stabilitate ${pct(S.stability[c.best])}` : "";
    return `<li data-p="${c.best}">
      <div class="top"><b>${fmt(c.lat, 2)}°, ${fmt(c.lon, 2)}°</b><span class="score" style="color:${scoreColor(c.bestScore)}">${pct(c.bestScore)}</span></div>
      <div class="meta">${c.cells.length} celule (~${fmt(c.cells.length * 3000 * Math.cos(c.lat * Math.PI / 180), 0)} km²) · medie ${pct(c.mean)}${stab}</div>
      <div class="meta">Cel mai apropiat analog cunoscut: ${esc(c.known.name)} (${fmt(c.known.km)} km)</div>
    </li>`;
  }).join("") || `<p class="hint">Nicio zonă nu trece filtrele.</p>`;
  $("#zones").querySelectorAll("li").forEach((li) => li.addEventListener("click", () => {
    const p = +li.dataset.p, [lat, lon] = cellLatLon(S.grid.cells[p]);
    S.map.flyTo([lat, lon], 5);
    showDetail(p);
  }));
}

function showDetail(p) {
  S.selected = p;
  const K = S.criteria.length, idx = S.grid.cells[p], [lat, lon] = cellLatLon(idx), t = S.target;
  const known = nearestKnown(lat, lon);
  const like = [], unlike = [];
  let missing = 0;
  const rows = S.criteria.map((c, k) => {
    const x = S.grid.values[c.id][p], s = S.sub[p * K + k], info = targetInfo(c);
    if (Number.isNaN(s)) missing++;
    else if (S.weights[c.id] > 0) { if (s >= 0.7) like.push(c.name); else if (s < 0.35) unlike.push(c.name); }
    const ev = c.binary ? (x === null ? "—" : x ? "da" : "nu") : `${fmt(x, c.decimals)} ${c.unit}`;
    const tv = c.binary ? (info.t ? "da" : "nu") : `${fmt(info.t, c.decimals)} ${c.unit}`;
    const note = info.outside ? `<div class="hint">comparat cu extrema Pământului: ${fmt(info.clamped, c.decimals)} ${c.unit}</div>` : "";
    const bar = Number.isNaN(s) ? `<span class="hint">fără date</span>` :
      `${pct(s)}<div class="meter"><i style="width:${s * 100}%;background:${scoreColor(s)}"></i></div>`;
    return `<tr><td>${esc(c.name)}${S.weights[c.id] === 0 ? ' <span class="hint">(pondere 0)</span>' : ""}</td><td>${ev}</td><td>${tv}${note}</td><td>${bar}</td></tr>`;
  }).join("");
  const stab = S.stability ? `<span class="k">Stabilitate (în top 1% la ponderi aleatoare)</span><span class="v">${pct(S.stability[p])}</span>` : "";
  const wv = `https://worldview.earthdata.nasa.gov/?v=${lon - 2},${lat - 1.5},${lon + 2},${lat + 1.5}`;
  const osm = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=8/${lat}/${lon}`;
  $("#detail").innerHTML = `
    <button class="close" title="Închide">×</button>
    <div class="hint">Celula de 0,5° de la</div>
    <h2>${fmt(lat, 2)}°, ${fmt(lon, 2)}°</h2>
    <div class="big">${pct(S.score[p])}</div>
    <div class="hint">similaritate cu ${esc(t.name)}</div>
    <div class="card kv" style="margin-top:10px">
      <span class="k">Analog cunoscut cel mai apropiat</span><span class="v">${esc(known.name)} (${fmt(known.km)} km)</span>
      ${stab}
      ${missing ? `<span class="k">Date lipsă</span><span class="v">${missing} criterii (scor penalizat)</span>` : ""}
    </div>
    <p><span class="yes">✔ Seamănă la:</span> ${like.length ? esc(like.join(", ")) : "—"}<br>
       <span class="no">✘ Diferă la:</span> ${unlike.length ? esc(unlike.join(", ")) : "—"}</p>
    <table class="cmp"><tr><th>Criteriu</th><th>Aici</th><th>${esc(t.name)}</th><th>Scor</th></tr>${rows}</table>
    <h3>Limitele analogiei</h3>
    <ul class="plain">${(t.limits || []).map((l) => `<li>${esc(l.name)}: ${esc(l.target)} (Pământ: ${esc(l.earth)})</li>`).join("")}</ul>
    <p><a href="${wv}" target="_blank" rel="noopener">Vezi în NASA Worldview ↗</a> · <a href="${osm}" target="_blank" rel="noopener">OpenStreetMap ↗</a></p>`;
  $("#detail").classList.remove("hidden");
  $("#detail .close").onclick = () => { $("#detail").classList.add("hidden"); if (S.selMarker) S.map.removeLayer(S.selMarker); S.selected = undefined; };
  if (S.selMarker) S.map.removeLayer(S.selMarker);
  const h = S.grid.res / 2;
  S.selMarker = L.rectangle([[lat - h, lon - h], [lat + h, lon + h]], { color: "#f0b429", weight: 2, fill: false }).addTo(S.map);
}

function runStability() {
  const btn = $("#stability"); btn.disabled = true; btn.textContent = "Se calculează…";
  setTimeout(() => {
    const n = S.grid.cells.length, hits = new Uint16Array(n), tmp = new Float32Array(n);
    for (let r = 0; r < STAB_RUNS; r++) {
      const w = {}; S.criteria.forEach((c) => { w[c.id] = Math.random() * 2; });
      scoreAll(w, tmp);
      const thr = topThreshold(tmp, TOP_FRACTION);
      for (let p = 0; p < n; p++) if (tmp[p] >= thr) hits[p]++;
    }
    S.stability = Float32Array.from(hits, (h) => h / STAB_RUNS);
    $("#stability-note").textContent = `Stabilitate = în câte din ${STAB_RUNS} combinații aleatoare de ponderi celula rămâne în primul ${TOP_FRACTION * 100}%. O zonă bună rămâne sus indiferent de ponderi.`;
    btn.disabled = false; btn.textContent = `Testează stabilitatea (${STAB_RUNS} de combinații de ponderi)`;
    renderZones();
    if (S.selected !== undefined) showDetail(S.selected);
  }, 30);
}

function selectTarget(id) {
  S.target = S.targets.find((t) => t.id === id);
  computeSub();
  renderTarget();
  recompute();
}

// ---------- pornire ----------
(async function main() {
  try {
    await load();
  } catch (e) {
    $("#loading").textContent = "Nu am putut încărca datele (" + e.message + "). Rulează scripturile din pipeline/ și pornește un server local.";
    return;
  }
  initMap();
  $("#target").innerHTML = S.targets.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  $("#target").onchange = (e) => selectTarget(e.target.value);
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button, .tab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active"); $("#" + b.dataset.tab).classList.add("active");
  }));
  $("#reset-weights").onclick = () => { S.criteria.forEach((c) => { S.weights[c.id] = c.weight; }); renderWeights(); recompute(); };
  $("#only-new").onchange = renderZones;
  $("#show-known").onchange = (e) => e.target.checked ? S.knownLayer.addTo(S.map) : S.map.removeLayer(S.knownLayer);
  $("#stability").onclick = runStability;
  renderWeights();
  selectTarget(S.targets[0].id);
  $("#loading").classList.add("hidden");
})();
