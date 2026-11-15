/* Analog Finder — "Method and data" page.
 * 1. Three steps from raw data to candidate sites, with the real numbers for the selected target.
 * 2. A criteria explorer: for one criterion at a time, how Earth's land is spread on it, each bar coloured
 *    by its match score with the target (the same greens as the map), plus a slider to try a value.
 * 3. The datasets behind it.
 * Uses S, $, $$, esc, fmt, pct, fmtVal, rankFn, targetInfo, applicable, oneSided, activeCriteria,
 * rampAt, rgbCss, SHARP, SITE_SHARE, BODY from app.js.
 */
"use strict";

(function () {
  const INK1 = "#eef1f4", INK2 = "#b4bcc6", INK3 = "#7c8794", LINE = "#262d37", AMBER = "#e8a33d", GREY = "#2a323d";
  const clip = (x) => Math.max(0, Math.min(1, x));
  const GOOD = 0.7;          // "close to the target" threshold used in the text and the stats
  let selId = null;
  let tryVal = {};           // slider value per criterion, kept while the page is open

  // How each criterion is computed (mirrors pipeline/), for criteria whose JSON entry has no "formula".
  const FORMULA = {
    slope_mean: "slope = arctan √((dz/dx)² + (dz/dy)²), mean over the cell",
    slope_p90: "90th percentile of the slopes in the cell",
    relief: "relief = z95 − z5 (95th and 5th percentile of elevation)",
    roughness: "standard deviation of elevation after removing the best-fit plane",
    t_mean: "mean over 12 months of (T_day + T_night) / 2",
    t_max: "daytime temperature of the warmest month",
    t_swing: "mean of (T_day − T_night)",
    cave_temp: "T_cave ≈ mean annual surface temperature above it",
    basalt_dist: "great-circle distance to the nearest Holocene basaltic volcano",
    precip: "annual total, mean of 2020–2024",
    low_sun: "100 × hours with 0° < Sun elevation < 10° ÷ hours with the Sun up",
    pressure: "p = 1013.25 × (1 − 2.25577·10⁻⁵ × z)^5.25588 hPa",
    ice: "1 if the mean ground temperature is below −5 °C",
  };
  const LIMIT = {
    slope_mean: "Computed on a ~3.7 km grid on all three bodies. Boulders and small craters are invisible at this scale.",
    slope_p90: "Computed on a ~3.7 km grid on all three bodies. Boulders and small craters are invisible at this scale.",
    relief: "Describes the whole cell, not a single slope.",
    roughness: "Separates broken terrain from a uniform tilt, but only at kilometre scale.",
    t_swing: "Earth's largest swing is far below the Moon's, so even the best places reproduce only part of the thermal shock.",
    cave_temp: "A proxy from surface temperature, not a measurement inside caves.",
    basalt_dist: "Shows where lava tubes are plausible, not where they have been mapped.",
    low_sun: "Ignores local terrain and atmospheric refraction.",
    pressure: "Estimated from elevation, not measured. Nowhere on Earth approaches vacuum or Mars pressure.",
    ice: "On Earth this is a temperature proxy for permafrost, not a measurement of ice.",
  };
  const SOURCES = [
    { body: "earth", n: "NOAA ETOPO1", what: "Global elevation, 1 arc-minute.", used: "Slopes, relief, roughness, craters, air pressure" },
    { body: "earth", n: "NASA MODIS Terra (MOD11C3, MOD13C2)", what: "Land surface temperature and vegetation index, monthly.", used: "Temperatures, day–night swing, ground ice, vegetation" },
    { body: "earth", n: "NASA GPM IMERG", what: "Satellite precipitation, monthly, 2020–2024.", used: "Rainfall" },
    { body: "earth", n: "NASA MERRA-2", what: "Atmospheric reanalysis, ~50 km.", used: "Dust, dust storms, wind, soil moisture" },
    { body: "earth", n: "TerraClimate · SoilGrids 2.0", what: "Aridity and soil organic carbon.", used: "Lifeless soil estimate" },
    { body: "earth", n: "Smithsonian Global Volcanism Program", what: "Holocene volcanoes.", used: "Distance to basaltic volcanoes (caves)" },
    { body: "moon", n: "NASA LRO LOLA", what: "Lunar elevation, 240 m at the poles.", used: "Lunar terrain and craters" },
    { body: "moon", n: "NASA LRO Diviner", what: "Lunar surface temperature and ice stability.", used: "Lunar temperatures and ice" },
    { body: "moon", n: "LROC pit catalogue", what: "Lunar pits and their host rock.", used: "Lunar cave targets" },
    { body: "mars", n: "NASA MGS MOLA", what: "Mars elevation, ~3.7 km.", used: "Martian terrain, craters, air pressure" },
    { body: "mars", n: "Mars Climate Database and landers", what: "Dust opacity and wind at the target.", used: "Martian dust and wind" },
    { body: "all", n: "Orbital mechanics", what: "Sun position from latitude and axial tilt.", used: "Low Sun, polar day and night on all three bodies" },
  ];

  // ---------- scoring helpers (same formulas as computeSub in app.js) ----------
  function scorer(c) {
    if (!applicable(c)) return null;
    if (oneSided(c)) return (x) => { const r = clip((x - c.lo) / ((c.hi - c.lo) || 1)); return c.mode === "lower" ? 1 - r : r; };
    const info = targetInfo(c);
    if (c.binary) return (x) => (x === info.clamped ? 1 : 0);
    const rank = rankFn(S.grid.quantiles[c.id]), rt = rank(info.clamped), span = (info.st.max - info.st.min) || 1;
    return (x) => Math.sqrt(Math.pow(1 - Math.abs(rank(x) - rt), SHARP) * Math.pow(Math.max(0, 1 - Math.abs(x - info.clamped) / span), 2));
  }
  const barFill = (s) => (s === null || s < 0.15 ? GREY : rgbCss(rampAt(0.15 + 0.85 * s)));

  // share of land per bin, and the share of land scoring >= GOOD
  const cache = {};
  function stats(c, sc) {
    const key = `${c.id}|${S.target.id}|${S.scenario}`;
    if (cache[key]) return cache[key];
    const vals = S.grid.values[c.id], st = S.grid.stats[c.id], nb = 44, span = (st.max - st.min) || 1;
    const bins = new Array(nb).fill(0);
    let n = 0, good = 0;
    for (const v of vals) {
      if (v === null) continue;
      n++;
      bins[Math.min(nb - 1, Math.floor((v - st.min) / span * nb))]++;
      if (sc && sc(v) >= GOOD) good++;
    }
    return (cache[key] = { bins: bins.map((b) => b / (n || 1)), n, good: good / (n || 1), nb });
  }

  // ---------- the chart ----------
  const niceMax = (m) => { const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1]; return steps.find((s) => s >= m) || 1; };
  function histogram(c, sc, x) {
    const info = targetInfo(c), st = info.st, { bins, nb } = stats(c, sc);
    const W = 760, H = 250, L = 46, R = 14, T = 26, B = 34, span = (st.max - st.min) || 1;
    const ymax = niceMax(Math.max(...bins) * 1.05);
    const tx = (v) => L + (v - st.min) / span * (W - L - R), ty = (s) => T + (1 - s / ymax) * (H - T - B), bw = (W - L - R) / nb;
    const ticks = [0, ymax / 2, ymax];
    let svg = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${ty(t)}" y2="${ty(t)}" stroke="${LINE}"${t ? ' stroke-dasharray="2 4"' : ""}/>
      <text x="${L - 8}" y="${ty(t) + 4}" fill="${INK3}" font-size="11" text-anchor="end">${Math.round(t * 1000) / 10}%</text>`).join("");
    bins.forEach((b, i) => {
      if (!b) return;
      const mid = st.min + (i + 0.5) * span / nb, h = Math.max(1.5, ty(0) - ty(b));
      svg += `<rect x="${(L + i * bw + 1).toFixed(1)}" y="${(ty(0) - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${barFill(sc ? sc(mid) : null)}"><title>${esc(fmtVal(c, st.min + i * span / nb))} to ${esc(fmtVal(c, st.min + (i + 1) * span / nb))}: ${(b * 100).toFixed(1)}% of land</title></rect>`;
    });
    // x axis
    svg += `<text x="${L}" y="${H - 12}" fill="${INK3}" font-size="11">${esc(fmtVal(c, st.min))}</text>
      <text x="${W - R}" y="${H - 12}" fill="${INK3}" font-size="11" text-anchor="end">${esc(fmtVal(c, st.max))}</text>
      <text x="${(L + W - R) / 2}" y="${H - 12}" fill="${INK3}" font-size="11" text-anchor="middle">${esc(c.name)}${c.unit ? ` (${esc(c.unit.trim())})` : ""}</text>`;
    // one-sided thresholds
    if (sc && oneSided(c)) {
      const full = c.mode === "lower" ? c.lo : c.hi, zero = c.mode === "lower" ? c.hi : c.lo;
      [[full, "full score"], [zero, "zero"]].forEach(([v, lab]) => {
        if (v < st.min || v > st.max) return;
        svg += `<line x1="${tx(v)}" x2="${tx(v)}" y1="${T - 6}" y2="${ty(0)}" stroke="${AMBER}" stroke-dasharray="3 3"/>
          <text x="${tx(v) + 4}" y="${T - 10}" fill="${AMBER}" font-size="11">${lab}: ${esc(fmtVal(c, v))}</text>`;
      });
    }
    // target marker
    if (sc && !oneSided(c)) {
      const px = tx(info.clamped), right = px > W * 0.6;
      const lab = info.outside ? `${esc(S.target.name)}: ${esc(fmtVal(c, info.t))} (beyond Earth)` : `${esc(S.target.name)}: ${esc(fmtVal(c, info.t))}`;
      svg += `<line x1="${px}" x2="${px}" y1="${T - 8}" y2="${ty(0)}" stroke="${AMBER}" stroke-width="2"/>
        <text x="${px + (right ? -6 : 6)}" y="${T - 12}" fill="${AMBER}" font-size="12" font-weight="600" text-anchor="${right ? "end" : "start"}">${lab}</text>`;
    }
    // the value being tried
    const pxv = tx(x);
    svg += `<line x1="${pxv}" x2="${pxv}" y1="${T + 6}" y2="${ty(0)}" stroke="${INK1}" stroke-width="1.5" stroke-dasharray="1 3"/>
      <circle cx="${pxv}" cy="${ty(0)}" r="5" fill="${INK1}" stroke="#0d1014" stroke-width="2"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribution of Earth's land for ${esc(c.name)}, coloured by match score">${svg}</svg>`;
  }

  function binaryChart(c, sc) {
    const vals = S.grid.values[c.id], info = targetInfo(c);
    let yes = 0, n = 0; for (const v of vals) { if (v === null) continue; n++; if (v === 1) yes++; }
    const rows = [["Yes", yes / (n || 1), 1], ["No", 1 - yes / (n || 1), 0]], W = 760, rh = 44;
    return `<svg viewBox="0 0 ${W} ${rows.length * rh + 6}" role="img" aria-label="Share of land with and without ${esc(c.name)}">${rows.map((r, i) => {
      const w = Math.max(3, r[1] * (W - 200)), s = sc ? sc(r[2]) : null;
      return `<text x="0" y="${i * rh + 26}" fill="${INK2}" font-size="13">${r[0]}</text>
        <rect x="60" y="${i * rh + 10}" width="${w}" height="22" rx="3" fill="${barFill(s)}"/>
        <text x="${68 + w}" y="${i * rh + 26}" fill="${INK1}" font-size="13" font-family="Fira Code, monospace">${pct(r[1])} of land${!info.na && r[2] === info.t ? `  ← ${esc(S.target.name)}` : ""}</text>`;
    }).join("")}</svg>`;
  }

  // ---------- page parts ----------
  function renderSteps() {
    const act = activeCriteria(), best = S.maxScore || 0;
    $("#m-lead").innerHTML = `Every land cell on Earth is compared with <b>${esc(S.target.name)}</b> (${esc(BODY[S.target.body] || S.target.body)}) on the same criteria, `
      + "using NASA and NOAA data. The numbers below are for that target; change it in the bar above.";
    $("#m-steps").innerHTML = `
      <li><span class="m-step-h">Read the data</span><span class="m-step-big">${fmt(S.grid.cells.length)}<small>land cells</small></span>
        <p>Earth's land on a ${S.grid.res}° grid (about 55 km). Each cell holds ${S.criteria.length} measured values: terrain, temperature, light, air, water, life.</p></li>
      <li><span class="m-step-h">Score each criterion</span><span class="m-step-big">${act.length}<small>criteria used for this target</small></span>
        <p>Each criterion gives 0–100%: how close the cell is to the target, both in Earth percentile and in actual value. Criteria the target has no data for are left out.</p></li>
      <li><span class="m-step-h">Combine and rank</span><span class="m-step-big">${pct(best)}<small>best match on Earth</small></span>
        <p>A weighted mean of the criteria scores. Neighbouring cells in Earth's top ${SITE_SHARE * 100}% are grouped into the ${fmt(S.clusters.length)} candidate sites on the map.</p></li>`;
  }

  function renderList() {
    const groups = [...new Set(S.criteria.map((c) => c.group))];
    $("#m-list").innerHTML = groups.map((g) => `<div class="m-grp">${esc(g)}</div>` + S.criteria.filter((c) => c.group === g).map((c) => {
      const on = applicable(c), info = targetInfo(c);
      const side = !on ? "not used" : oneSided(c) ? (c.mode === "lower" ? "lower ✓" : "higher ✓") : fmtVal(c, info.t);
      return `<button type="button" class="m-item${on ? "" : " is-off"}" data-cid="${c.id}" aria-current="${c.id === selId}"><span>${esc(c.name)}</span><small>${esc(side)}</small></button>`;
    }).join("")).join("");
  }

  function renderDetail() {
    const c = S.criteria.find((k) => k.id === selId), info = targetInfo(c), sc = scorer(c), st = info.st;
    const body = S.target.body, on = !!sc;
    const tags = [`<span class="m-tag">${esc(c.group)}</span>`];
    if (!on) tags.push(`<span class="m-tag is-off">Not used for ${esc(S.target.name)}</span>`);
    else if (oneSided(c)) tags.push(`<span class="m-tag is-target">${c.mode === "lower" ? "Lower is better" : "Higher is better"}</span>`);
    else tags.push(`<span class="m-tag is-target">Target: ${esc(fmtVal(c, info.t))}</span>`);
    if (c.bodies && c.bodies.length === 1) tags.push(`<span class="m-tag">${esc(BODY[c.bodies[0]])} only</span>`);
    if (c.scenario) tags.push(`<span class="m-tag">${c.scenario === "storm" ? "Dust storm scenario" : "Normal conditions"}</span>`);

    let chart, tryer = "";
    if (c.binary) {
      chart = binaryChart(c, sc);
    } else {
      if (tryVal[c.id] === undefined) tryVal[c.id] = on && !oneSided(c) ? info.clamped : S.grid.quantiles[c.id][100];
      chart = histogram(c, sc, tryVal[c.id]);
      tryer = `<label class="m-try"><span>Try a value</span><input type="range" id="m-range" min="${st.min}" max="${st.max}" step="${((st.max - st.min) / 500) || 1}" value="${tryVal[c.id]}"><output id="m-out"></output></label>
        <div class="m-facts" id="m-facts"></div>`;
    }
    const { good } = stats(c, sc);
    const tsrc = (c.target_source || {})[body];
    $("#m-detail").innerHTML = `
      <div class="m-dhead"><div><h3>${esc(c.name)}</h3><p class="m-what">${esc(c.description)}</p></div><div class="m-tags">${tags.join("")}</div></div>
      <div class="m-chart">
        <div class="m-chart-h"><span><b>Earth's land on this criterion</b> · height = share of land</span>
          ${on ? `<span><b>${pct(good)}</b> of land scores ${GOOD * 100}% or more</span>` : ""}</div>
        ${chart}
        <div class="m-key">${on ? `<span><i class="ramp"></i>closer to the target (same greens as the map)</span><span><i class="grey"></i>poor match</span>` : `<span><i class="grey"></i>not scored for this target</span>`}
          ${on && !oneSided(c) && !c.binary ? `<span><i class="tline"></i>target</span>` : ""}${c.binary ? "" : `<span><i class="pline"></i>the value you try</span>`}</div>
      </div>
      ${tryer}
      <div class="m-info">
        <div><h4>Data</h4><dl><dt>Earth</dt><dd>${esc(c.earth_source)}</dd><dt>${esc(BODY[body] || body)}</dt><dd>${esc(tsrc || "—")}</dd></dl></div>
        <div><h4>How it is computed</h4><code class="m-formula">${esc(c.formula || FORMULA[c.id] || c.description)}</code></div>
        <div><h4>How it is scored</h4><p>${!on ? `Left out: ${esc(S.target.name)} has no value for it${c.scenario && c.scenario !== S.scenario ? " in this scenario" : ""}.`
          : c.binary ? "Yes/no: 100% when the place agrees with the target, 0% when it does not."
          : oneSided(c) ? `${c.mode === "lower" ? "Less is better" : "More is better"}: 100% ${c.mode === "lower" ? "at or below" : "at or above"} ${esc(fmtVal(c, c.mode === "lower" ? c.lo : c.hi))}, 0% ${c.mode === "lower" ? "from" : "at or below"} ${esc(fmtVal(c, c.mode === "lower" ? c.hi : c.lo))}.`
          : `Closeness to ${esc(fmtVal(c, info.t))} in Earth percentile × closeness in value.${info.outside ? " The target lies beyond anything on Earth, so it is compared with Earth's closest extreme." : ""}`}</p></div>
        <div><h4>Why it matters</h4><p>${esc(c.why)}</p></div>
        ${c.limit || LIMIT[c.id] ? `<div class="m-limit"><h4>Limits</h4><p>${esc(c.limit || LIMIT[c.id])}</p></div>` : ""}
        ${c.licence ? `<div><h4>Licence</h4><p>${esc(c.licence)}</p></div>` : ""}
      </div>`;
    if (!c.binary) updateTry(c, sc);
  }

  function updateTry(c, sc) {
    const x = tryVal[c.id], rank = rankFn(S.grid.quantiles[c.id]), s = sc ? sc(x) : null;
    $("#m-out").textContent = fmtVal(c, x);
    $("#m-facts").innerHTML = `<div><b>${esc(fmtVal(c, x))}</b>a place with this value</div>
      <div><b>${rank(x) > 0.99 && rank(x) < 1 ? "&gt;99%" : rank(x) < 0.01 && rank(x) > 0 ? "&lt;1%" : pct(rank(x))}</b>of Earth's land is lower</div>
      <div class="hl"><b>${s === null ? "—" : pct(s)}</b>${s === null ? "not scored for this target" : `match with ${esc(S.target.name)}`}</div>`;
    $("#m-detail .m-chart svg").outerHTML = histogram(c, sc, x);
  }

  function renderSources() {
    $("#m-sources").innerHTML = SOURCES.map((d) => `<div class="m-src">${d.body === "all" ? '<span class="m-body earth">Earth</span><span class="m-body moon">Moon</span><span class="m-body mars">Mars</span>'
      : `<span class="m-body ${d.body}">${esc(BODY[d.body] || d.body)}</span>`}<b>${esc(d.n)}</b><p>${esc(d.what)}</p><small>Used for: ${esc(d.used)}</small></div>`).join("");
  }

  window.renderDocs = function () {
    if (!S.criteria.some((c) => c.id === selId)) selId = (activeCriteria()[0] || S.criteria[0]).id;
    renderSteps();
    renderList();
    renderDetail();
    renderSources();
  };

  const root = $("#view-docs");
  root.addEventListener("click", (e) => {
    const it = e.target.closest("[data-cid]");
    if (!it) return;
    selId = it.dataset.cid;
    $$("#m-list .m-item").forEach((b) => b.setAttribute("aria-current", String(b.dataset.cid === selId)));
    renderDetail();
  });
  root.addEventListener("input", (e) => {
    if (e.target.id !== "m-range") return;
    const c = S.criteria.find((k) => k.id === selId);
    tryVal[c.id] = +e.target.value;
    updateTry(c, scorer(c));
  });
})();
