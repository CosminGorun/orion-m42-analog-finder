/* Analog Finder — "Method and data" page.
 * Every criterion in criteria.json gets a card with a live playground: a slider over Earth's real range,
 * the real distribution of Earth's land and the real match-score curve against the selected target.
 * Planned criteria (not in the data yet) get a formula playground instead.
 * Uses S, $, $$, esc, fmt, pct, fmtVal, rankFn, targetInfo, applicable, SHARP, BODY from app.js.
 */
"use strict";

(function () {
  const INK2 = "#b4bcc6", INK3 = "#7c8794", LINE = "#35404d", GREEN = "#5cc96c", AMBER = "#e8a33d", BAR = "#2a323d";
  const clip = (x) => Math.max(0, Math.min(1, x));
  const fx = (x, d = 2) => Number(x).toFixed(d);
  let group = null;

  // How each existing criterion is computed (mirrors pipeline/common.py and build_earth_grid.py).
  const FORMULA = {
    slope_mean: "slope = arctan( √( (dz/dx)² + (dz/dy)² ) ), mean over the window",
    slope_p90: "90th percentile of the per-pixel slopes in the window",
    relief: "relief = z95 − z5 (95th and 5th percentile of elevation)",
    roughness: "standard deviation of elevation after removing the best-fit plane",
    t_mean: "mean over 12 months of (T_day + T_night) / 2",
    t_max: "daytime temperature of the warmest month",
    t_swing: "mean( T_day − T_night )",
    cave_temp: "T_cave ≈ mean annual surface temperature above it",
    basalt_dist: "great-circle distance to the nearest Holocene basaltic volcano",
    precip: "annual total, mean of 2020–2024",
    low_sun: "100 × hours with 0° < Sun elevation < 10° ÷ hours with the Sun up",
    pressure: "p = 1013.25 × (1 − 2.25577·10⁻⁵ × z)^5.25588 hPa",
    ice: "Earth: 1 if the mean ground temperature is below −5 °C",
  };
  const LIMIT = {
    slope_mean: "Computed on a ~3.7 km grid, the same on all three bodies. Boulders and small craters are invisible at this scale.",
    slope_p90: "Computed on a ~3.7 km grid, the same on all three bodies. Boulders and small craters are invisible at this scale.",
    relief: "Describes the whole ~50 km window, not a single slope.",
    roughness: "Separates broken terrain from a uniform tilt, but only at kilometre scale.",
    t_swing: "Earth's largest swing is far below the Moon's, so even the best cells reproduce part of the thermal shock.",
    cave_temp: "A proxy from surface temperature, not a measurement inside caves.",
    basalt_dist: "Shows where lava tubes are plausible, not where they have been mapped.",
    low_sun: "Ignores local terrain and atmospheric refraction.",
    pressure: "Estimated from elevation, not measured. Nowhere on Earth approaches vacuum or Mars pressure.",
    ice: "On Earth this is a temperature proxy for permafrost, not a measurement of ice.",
  };

  // ---------- small SVG helpers ----------
  function curve(fn, x0, x1, x, xlab) {
    const W = 440, H = 150, L = 34, B = 26, T = 10, R = 10;
    const tx = (v) => L + (v - x0) / (x1 - x0) * (W - L - R), ty = (s) => T + (1 - s) * (H - T - B);
    let d = "";
    for (let i = 0; i <= 80; i++) { const v = x0 + i / 80 * (x1 - x0); d += `${i ? "L" : "M"}${tx(v).toFixed(1)} ${ty(fn(v)).toFixed(1)}`; }
    const cx = tx(Math.max(x0, Math.min(x1, x))), cy = ty(fn(x));
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Score curve">
      <line x1="${L}" y1="${ty(0)}" x2="${W - R}" y2="${ty(0)}" stroke="${LINE}"/>
      <line x1="${L}" y1="${ty(1)}" x2="${W - R}" y2="${ty(1)}" stroke="${LINE}" stroke-dasharray="3 4"/>
      <text x="${L - 6}" y="${ty(1) + 4}" fill="${INK3}" font-size="11" text-anchor="end">1</text>
      <text x="${L - 6}" y="${ty(0) + 4}" fill="${INK3}" font-size="11" text-anchor="end">0</text>
      <text x="${L}" y="${H - 6}" fill="${INK3}" font-size="11">${x0}</text>
      <text x="${W - R}" y="${H - 6}" fill="${INK3}" font-size="11" text-anchor="end">${x1}</text>
      <text x="${W / 2}" y="${H - 6}" fill="${INK2}" font-size="11" text-anchor="middle">${xlab}</text>
      <path d="${d}" fill="none" stroke="${GREEN}" stroke-width="2"/>
      <line x1="${cx}" y1="${ty(0)}" x2="${cx}" y2="${cy}" stroke="${AMBER}" stroke-dasharray="2 3"/>
      <circle cx="${cx}" cy="${cy}" r="6" fill="${AMBER}"/></svg>`;
  }
  function bars(rows, max, unitTxt) {
    const W = 440, rh = 30;
    return `<svg viewBox="0 0 ${W} ${rows.length * rh + 4}" role="img" aria-label="Comparison bars">${rows.map((r, i) => {
      const w = Math.max(2, r[1] / max * 240);
      return `<text x="0" y="${i * rh + 19}" fill="${INK2}" font-size="12">${r[0]}</text>
        <rect x="124" y="${i * rh + 7}" width="${w}" height="16" rx="3" fill="${r[2] || GREEN}"/>
        <text x="${130 + w}" y="${i * rh + 19}" fill="#eef1f4" font-size="12" font-family="Fira Code, monospace">${r[3]}${unitTxt || ""}</text>`;
    }).join("")}</svg>`;
  }
  const res = (items) => `<div class="d-res">${items.map((r) => `<div${r[2] ? ' class="hl"' : ""}><b>${r[1]}</b>${r[0]}</div>`).join("")}</div>`;

  // ---------- live playground on real data ----------
  const histCache = {};
  function hist(c) {
    if (histCache[c.id]) return histCache[c.id];
    const st = S.grid.stats[c.id], rank = rankFn(S.grid.quantiles[c.id]), nb = 48, span = (st.max - st.min) || 1, h = [];
    for (let i = 0; i < nb; i++) h.push(Math.max(0, rank(st.min + (i + 1) * span / nb) - rank(st.min + i * span / nb)));
    const mx = Math.max(...h) || 1;
    return (histCache[c.id] = h.map((v) => Math.sqrt(v / mx)));
  }
  function scorer(c) {
    if (!applicable(c)) return null;
    if (oneSided(c)) return (x) => { const r = clip((x - c.lo) / ((c.hi - c.lo) || 1)); return c.mode === "lower" ? 1 - r : r; };
    const info = targetInfo(c);
    const rank = rankFn(S.grid.quantiles[c.id]), rt = rank(info.clamped), span = (info.st.max - info.st.min) || 1;
    return (x) => Math.sqrt(Math.pow(1 - Math.abs(rank(x) - rt), SHARP) * Math.pow(Math.max(0, 1 - Math.abs(x - info.clamped) / span), 2));
  }
  function liveViz(c, x) {
    const info = targetInfo(c), st = info.st, sc = scorer(c), h = hist(c);
    const W = 440, H = 176, L = 8, R = 8, T = 14, B = 30, span = (st.max - st.min) || 1;
    const tx = (v) => L + (v - st.min) / span * (W - L - R), ty = (s) => T + (1 - s) * (H - T - B), bw = (W - L - R) / h.length;
    let d = "";
    if (sc) for (let i = 0; i <= 120; i++) { const v = st.min + i / 120 * span; d += `${i ? "L" : "M"}${tx(v).toFixed(1)} ${ty(sc(v)).toFixed(1)}`; }
    const cx = tx(x), cy = sc ? ty(sc(x)) : ty(0);
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Earth distribution and match score for ${esc(c.name)}">
      ${h.map((v, i) => `<rect x="${(L + i * bw + 0.5).toFixed(1)}" y="${ty(v * 0.92).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${(ty(0) - ty(v * 0.92)).toFixed(1)}" fill="${BAR}"/>`).join("")}
      <line x1="${L}" y1="${ty(0)}" x2="${W - R}" y2="${ty(0)}" stroke="${LINE}"/>
      ${sc ? `<path d="${d}" fill="none" stroke="${GREEN}" stroke-width="2"/>` : ""}
      ${sc && !oneSided(c) ? `<line x1="${tx(info.clamped)}" y1="${T - 4}" x2="${tx(info.clamped)}" y2="${ty(0)}" stroke="${AMBER}" stroke-dasharray="3 3"/>
      <text x="${Math.min(W - 44, Math.max(44, tx(info.clamped)))}" y="${T - 4}" fill="${AMBER}" font-size="11" text-anchor="middle">target</text>` : ""}
      <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${ty(0)}" stroke="#eef1f4" stroke-opacity=".5"/>
      <circle cx="${cx}" cy="${cy}" r="6" fill="#eef1f4" stroke="#0d1014" stroke-width="2"/>
      <text x="${L}" y="${H - 8}" fill="${INK3}" font-size="11">${esc(fmtVal(c, st.min))}</text>
      <text x="${W - R}" y="${H - 8}" fill="${INK3}" font-size="11" text-anchor="end">${esc(fmtVal(c, st.max))}</text>
      <text x="${W / 2}" y="${H - 8}" fill="${INK2}" font-size="11" text-anchor="middle">Earth's range · grey = share of land (square-root scale)</text></svg>`;
  }
  function updateLive(box) {
    const c = S.criteria.find((k) => k.id === box.dataset.cid), x = +box.querySelector("input").value;
    const sc = scorer(c), rank = rankFn(S.grid.quantiles[c.id]), info = targetInfo(c), s = sc ? sc(x) : null;
    box.querySelector("output").textContent = fmtVal(c, x);
    box.querySelector(".d-out").innerHTML = `<div class="d-viz">${liveViz(c, x)}</div>` +
      res([["a place with this value", esc(fmtVal(c, x))], ["higher than this share of Earth's land", pct(rank(x))],
        ...(sc ? [[oneSided(c) ? "score" : `match with ${esc(S.target.name)}`, pct(s), 1]] : [])]) +
      `<p class="d-say">${!sc ? `Not scored for ${esc(S.target.name)}${c.scenario && c.scenario !== S.scenario ? " in this scenario" : ""}: it does not apply or the target has no value.`
        : oneSided(c) ? (s >= 0.7 ? "A good place on this criterion." : s >= 0.35 ? "In between." : "A poor place on this criterion.")
        : s >= 0.7 ? "Close to the target on this criterion." : s >= 0.35 ? "Partly similar." : "Unlike the target here."}
      ${sc && !oneSided(c) && info.outside ? ` The target (${esc(fmtVal(c, info.t))}) lies outside Earth's range, so places are compared with the closest Earth extreme.` : ""}</p>`;
  }
  function liveCard(c) {
    const info = targetInfo(c), st = info.st, q = S.grid.quantiles[c.id], body = S.target.body;
    let play;
    if (c.binary) {
      const vals = S.grid.values[c.id], yes = vals.reduce((a, v) => a + (v === 1 ? 1 : 0), 0), n = vals.reduce((a, v) => a + (v === null ? 0 : 1), 0) || 1;
      play = `<div class="d-viz">${bars([["Yes", yes / n, GREEN, pct(yes / n)], ["No", 1 - yes / n, BAR, pct(1 - yes / n)]], 1)}</div>
        ${res([["of Earth's land has it", pct(yes / n)], [`at ${esc(S.target.name)}`, info.na ? "—" : info.t ? "Yes" : "No", 1]])}
        <p class="d-say">A yes/no criterion: a place scores 100% when it agrees with the target and 0% when it does not.</p>`;
    } else {
      const start = q[100];
      const presets = [["Earth median", q[100]], ["Lowest 5%", q[10]], ["Highest 5%", q[190]], ...(info.na || oneSided(c) ? [] : [["Target", info.clamped]])];
      play = `<div class="d-live" data-cid="${c.id}">
        <label class="d-ctl"><span>Value of a place</span><input type="range" min="${st.min}" max="${st.max}" step="${((st.max - st.min) / 400) || 1}" value="${start}"><output></output></label>
        <div class="d-presets">${presets.map((p) => `<button data-set="${p[1]}">${p[0]}</button>`).join("")}</div><div class="d-out"></div></div>`;
    }
    const phys = PHYS[c.id] ? `<details class="d-phys"><summary>See the physics</summary>${playBox(PHYS[c.id])}</details>` : "";
    return `<article class="d-card">
      <div class="d-head"><div><h3>${esc(c.name)}</h3><p class="d-what">${esc(c.description)}</p></div>
        <div class="d-meta"><span class="d-tag is-live">In the app</span><span class="d-tag">${esc(c.group)}</span>
        ${!applicable(c) ? `<span class="d-tag">Not used for ${esc(S.target.name)}</span>`
          : oneSided(c) ? `<span class="d-tag">${c.mode === "lower" ? "Lower is better" : "Higher is better"}</span>` : `<span class="d-tag">Target: ${esc(fmtVal(c, info.t))}</span>`}
        ${c.bodies && c.bodies.length === 1 ? `<span class="d-tag">${esc(BODY[c.bodies[0]])} only</span>` : ""}
        ${c.scenario ? `<span class="d-tag">${c.scenario === "storm" ? "Dust storm scenario" : "Normal conditions"}</span>` : ""}</div></div>
      <div class="d-flow"><div><b>1 · Earth data</b>${esc(c.earth_source)}</div><div><b>2 · Target data</b>${esc((c.target_source || {})[body] || "—")}</div>
        <div><b>3 · Scored</b>${c.binary ? "Yes/no agreement with the target."
          : oneSided(c) ? `${c.mode === "lower" ? "Less is better" : "More is better"}: full score ${c.mode === "lower" ? "at or below" : "at or above"} ${esc(fmtVal(c, c.mode === "lower" ? c.lo : c.hi))}, zero ${c.mode === "lower" ? "from" : "at or below"} ${esc(fmtVal(c, c.mode === "lower" ? c.hi : c.lo))}.`
          : "Match: closeness in Earth percentile × closeness in value."}</div></div>
      <div class="d-body"><div class="d-play"><div class="d-play-h">Try it on the real data</div>${play}</div>
        <div class="d-info"><div><h4>How it is computed</h4><code class="d-formula">${esc(c.formula || FORMULA[c.id] || c.description)}</code></div>
        <div><h4>Why it matters</h4><p>${esc(c.why)}</p></div>
        ${c.limit || LIMIT[c.id] ? `<div class="d-limit"><h4>Where it stops being valid</h4><p>${esc(c.limit || LIMIT[c.id])}</p></div>` : ""}
        ${c.licence ? `<div><h4>Licence</h4><p>${esc(c.licence)}</p></div>` : ""}${phys}</div></div></article>`;
  }

  // ---------- formula playgrounds ----------
  const PLAY = {
    slope: {
      ctl: [["rise", "Rise over 100 m", 0, 120, 1, 36, " m"]],
      run: (v) => {
        const a = Math.atan(v.rise / 100) * 180 / Math.PI, y = 130 - Math.min(120, v.rise);
        return `<div class="d-viz"><svg viewBox="0 0 440 150" role="img" aria-label="Slope triangle"><path d="M40 130 L340 130 L340 ${y} Z" fill="#1d5a35" stroke="${GREEN}" stroke-width="2"/>
          <text x="190" y="146" fill="${INK3}" font-size="11" text-anchor="middle">100 m</text><text x="348" y="${(130 + y) / 2 + 4}" fill="${INK3}" font-size="11">${v.rise} m</text>
          <text x="92" y="124" fill="${AMBER}" font-size="13" font-family="Fira Code, monospace">${fx(a, 1)}°</text></svg></div>${res([["slope angle", `${fx(a, 1)}°`, 1], ["gradient", `${v.rise}%`]])}`;
      },
    },
    shadow: {
      ctl: [["e", "Sun elevation", 0.5, 45, 0.5, 1.5, "°"], ["h", "Obstacle height", 0.5, 10, 0.5, 2, " m"]],
      presets: [["Lunar south pole", { e: 1.5 }], ["Low Sun limit", { e: 10 }], ["Mid-latitude noon", { e: 45 }]],
      run: (v) => {
        const Lm = v.h / Math.tan(v.e * Math.PI / 180), px = Math.min(340, 12 + Math.log10(1 + Lm) * 108), hp = 12 + v.h * 9;
        return `<div class="d-viz"><svg viewBox="0 0 440 150" role="img" aria-label="Shadow length"><line x1="10" y1="130" x2="430" y2="130" stroke="${LINE}"/>
          <rect x="60" y="130" width="${px}" height="6" fill="#000" stroke="${LINE}"/><rect x="50" y="${130 - hp}" width="10" height="${hp}" fill="${INK2}"/>
          <circle cx="26" cy="${122 - 110 * Math.sin(v.e * Math.PI / 180)}" r="9" fill="${AMBER}"/>
          <text x="${60 + px / 2}" y="148" fill="${INK3}" font-size="11" text-anchor="middle">shadow (log scale)</text></svg></div>
          ${res([["shadow length", `${fx(Lm, Lm < 10 ? 1 : 0)} m`, 1], ["times the height", `${fx(Lm / v.h, 1)}×`]])}
          <p class="d-say">${v.e < 10 ? "Below 10°: counted as low Sun. Long shadows hide hazards from cameras." : "At or above 10°: not counted as low Sun."}</p>`;
      },
    },
    swing: {
      ctl: [["dt", "Day–night swing", 0, 300, 5, 90, " °C"], ["a", "Expansion coefficient", 5, 30, 1, 23, " µm/m·K"]],
      presets: [["Earth desert", { dt: 40 }], ["Mars", { dt: 90 }], ["Moon", { dt: 280 }], ["Steel", { a: 12 }], ["Aluminium", { a: 23 }]],
      run: (v) => `<div class="d-viz">${bars([["Earth, largest", 40, "#1f7d42", "~40"], ["Mars", 90, "#27a24f", "80–100"], ["Moon", 280, GREEN, "~280"], ["Your value", v.dt, AMBER, v.dt]], 300, " °C")}</div>
        ${res([["length change per metre, each cycle", `${fx(v.a * v.dt / 1000, 2)} mm`, 1]])}
        <p class="d-say">Strain = coefficient × swing. Repeated daily, it cracks solder joints and loosens seals.</p>`,
    },
    cave: {
      ctl: [["h", "Time in the lunar day", 0, 29.5, 0.5, 7, " days"]],
      run: (v) => {
        const surf = v.h < 14.75 ? -170 + 290 * Math.sin(Math.PI * v.h / 14.75) : -170;
        return `<div class="d-viz">${bars([["Surface (sketch)", surf + 180, surf > 0 ? AMBER : "#378add", fx(surf, 0)], ["Inside the pit", 197, GREEN, "17"]], 310, " °C")}</div>
          ${res([["surface minus pit", `${fx(surf - 17, 0)} °C`, 1]])}
          <p class="d-say">The surface curve is a simplified sketch between about −170 and +120 °C. The +17 °C pit value is modelled from Diviner data (Horvath et al., 2022).</p>`;
      },
    },
    dust: {
      ctl: [["t", "Dust optical depth τ", 0.05, 11, 0.05, 0.5, ""]],
      presets: [["Clear Mars day", { t: 0.5 }], ["Severe Earth storm", { t: 4 }], ["Mars, June 2018", { t: 10.8 }]],
      run: (v) => {
        const direct = Math.exp(-v.t), sc = clip(1 - Math.abs(Math.log10(v.t / 0.5)) / Math.log10(20)), k = Math.min(1, v.t / 6);
        return `<div class="d-viz"><svg viewBox="0 0 440 96" role="img" aria-label="Sunlight dimming"><rect width="440" height="96" fill="rgb(${Math.round(40 + 150 * k)},${Math.round(34 + 70 * k)},28)" opacity="${0.25 + 0.6 * k}"/>
          <circle cx="70" cy="48" r="26" fill="${AMBER}" opacity="${Math.max(0.06, direct)}"/><circle cx="70" cy="48" r="26" fill="none" stroke="${AMBER}" stroke-dasharray="3 4"/>
          <rect x="130" y="40" width="290" height="16" rx="3" fill="#202630"/><rect x="130" y="40" width="${Math.max(1, 290 * direct)}" height="16" rx="3" fill="${AMBER}"/>
          <text x="130" y="30" fill="${INK2}" font-size="12">Direct sunlight reaching the ground</text></svg></div>
          ${res([["direct beam, Sun overhead", `${direct * 100 < 0.1 ? "<0.1" : fx(direct * 100, direct < 0.1 ? 1 : 0)}%`, 1], ["match with a target at τ = 0.5", fx(sc)]])}
          <p class="d-say">Direct light falls as e^(−τ). Scattered light still arrives, which is why Opportunity kept about 3% of its power (645 → 22 Wh) instead of none.</p>`;
      },
    },
    wind: {
      ctl: [["v", "Wind speed on Mars", 0, 40, 1, 25, " m/s"]],
      presets: [["Typical day", { v: 3 }], ["Afternoon", { v: 7 }], ["Strong gust", { v: 25 }]],
      run: (v) => `<div class="d-viz">${bars([["On Mars", v.v, "#27a24f", fx(v.v, 0)], ["Feels like, Earth", 0.12 * v.v, AMBER, fx(0.12 * v.v, 1)]], 40, " m/s")}</div>
        ${res([["Earth-equivalent push", `${fx(0.12 * v.v * 3.6, 0)} km/h`, 1], ["Mars speed", `${fx(v.v * 3.6, 0)} km/h`]])}
        <p class="d-say">Force goes with ½·ρ·v² and Mars air is 60–80 times thinner, so the wind is fast but weak. What matters is the sand and dust it moves.</p>`,
    },
    ndvi: {
      ctl: [["r", "Red reflectance", 0.02, 0.5, 0.01, 0.2, ""], ["n", "Near-infrared", 0.02, 0.6, 0.01, 0.22, ""]],
      presets: [["Bare rock", { r: 0.2, n: 0.22 }], ["Sparse scrub", { r: 0.14, n: 0.2 }], ["Forest", { r: 0.04, n: 0.45 }]],
      run: (v) => {
        const nd = (v.n - v.r) / (v.n + v.r), fn = (x) => clip((0.2 - x) / 0.1);
        return `<div class="d-viz">${curve(fn, -0.2, 0.8, nd, "NDVI")}</div>${res([["NDVI", fx(nd)], ["score", fx(fn(nd)), 1]])}
          <p class="d-say">${nd <= 0.1 ? "Bare ground: full score." : nd < 0.2 ? "Sparse vegetation: partial score." : "Vegetated: score 0."} Plants absorb red and reflect near-infrared, so the gap between the two bands grows with plant cover.</p>`;
      },
    },
    microbe: {
      ctl: [["ai", "Aridity index (log10)", -2.7, 0, 0.05, -2.3, ""], ["soc", "Soil organic carbon", 0.5, 40, 0.5, 1, " g/kg"], ["t", "Mean air temperature", -30, 30, 1, 16, " °C"], ["v", "Plant growth seen (0 no, 1 yes)", 0, 1, 1, 0, ""]],
      presets: [["Hyperarid desert", { ai: -2.3, soc: 1, t: 16, v: 0 }], ["Polar desert", { ai: -1.2, soc: 1, t: -23, v: 0 }], ["Farmland", { ai: -0.2, soc: 20, t: 11, v: 1 }]],
      run: (v) => {
        const Wt = clip((Math.log10(0.2) - v.ai) / (Math.log10(0.2) - Math.log10(0.002))), C = clip((Math.log10(20) - Math.log10(v.soc)) / Math.log10(20));
        const T = clip((5 - v.t) / 30), V = v.v ? 0 : 1, LB = 0.45 * Wt + 0.30 * C + 0.15 * T + 0.10 * V;
        return `<div class="d-viz">${bars([["Water, ×0.45", Wt, GREEN, fx(Wt)], ["Carbon, ×0.30", C, GREEN, fx(C)], ["Cold, ×0.15", T, GREEN, fx(T)], ["No plants, ×0.10", V, GREEN, V]], 1)}</div>
          ${res([["low-biomass score", fx(LB), 1], ["aridity index", fx(Math.pow(10, v.ai), 3)]])}
          <p class="d-say">${LB >= 0.8 ? "Candidate near-lifeless soil." : LB >= 0.5 ? "Low biomass." : "Ordinary living soil."} An estimate from climate and soil, not a count of microbes.</p>`;
      },
    },
    moisture: {
      ctl: [["m", "Soil moisture", 0, 0.4, 0.005, 0.03, " m³/m³"]],
      run: (v) => {
        const fn = (x) => clip((0.10 - x) / 0.08);
        return `<div class="d-viz">${curve(fn, 0, 0.4, v.m, "soil moisture, m³/m³")}</div>${res([["score", fx(fn(v.m)), 1]])}
          <p class="d-say">${v.m <= 0.02 ? "Dry enough for radar to see deep." : v.m < 0.10 ? "Some water: radar loses depth." : "Too wet: water absorbs the radar signal near the surface."} Thresholds 0.02 and 0.10 are a proposal, to be calibrated.</p>`;
      },
    },
    fill: {
      ctl: [["lvl", "Fill level", 0, 100, 1, 100, "%"]],
      run: (v) => {
        const top = 46, deep = 104, y = deep - (deep - top) * v.lvl / 100;
        return `<div class="d-viz"><svg viewBox="0 0 440 130" role="img" aria-label="Closed depression filling"><defs><clipPath id="d-bowl"><path d="M120 46 Q150 104 210 104 Q270 104 300 46 Z"/></clipPath></defs>
          <rect x="120" y="${y}" width="180" height="${deep - y}" fill="#1f7d42" clip-path="url(#d-bowl)"/>
          <path d="M10 60 L90 52 L120 46 Q150 104 210 104 Q270 104 300 46 L330 52 L430 64" fill="none" stroke="${INK2}" stroke-width="2"/>
          <line x1="120" y1="46" x2="300" y2="46" stroke="${AMBER}" stroke-dasharray="3 4"/><text x="306" y="42" fill="${AMBER}" font-size="11">spill level</text></svg></div>
          <p class="d-say">The elevation model is “flooded” until water would spill. Filled minus original gives the depth of every closed hollow, with one formula on Earth, Moon and Mars.</p>`;
      },
    },
  };
  const PHYS = {
    slope_mean: "slope", low_sun: "shadow", t_swing: "swing", cave_temp: "cave", dep_frac: "fill",
    dust: "dust", wind: "wind", ndvi: "ndvi", low_biomass: "microbe", soil_moist: "moisture",
  };

  const PLANNED = [
    { n: "Dust exposure", ids: ["dust"], tags: ["Atmosphere", "Mars only"], play: "dust", what: "How much airborne dust dims the sunlight, as dust optical depth.",
      flow: ["Earth: NASA MERRA-2 reanalysis, dust-only optical depth. Mars: infrared retrievals from orbit (Montabone climatology).", "Daily values: mean, 95th percentile, dusty days, longest spell.", "Normal conditions: match with the target. Dust storm: more is better."],
      f: "normal = 1 − |log10(τ_Earth / τ_target)| / log10(20);  storm = 0.30·P95 + 0.30·days + 0.25·spell + 0.15·mean",
      why: "Dust in the air cuts solar power. Settled dust is a second, slower problem that ended InSight.",
      lim: "Earth storms reach τ 3–5 for hours to days. Mars reached 10.8 for months in 2018. Earth tests dimming, deposition and cleaning, not months of darkness." },
    { n: "Wind", ids: ["wind"], tags: ["Atmosphere", "Mars only"], play: "wind", what: "The Earth wind that pushes on hardware as hard as a given Mars wind.",
      flow: ["Mars: lander weather stations. Earth: MERRA-2 wind at 10 m.", "Convert by air density, compare with Earth's 95th percentile.", "Match with the target value."],
      f: "v_equivalent = v_Mars × √( ρ_Mars / ρ_Earth ) ≈ 0.12 × v_Mars",
      why: "Serves parachute, landing and tall-structure tests. Sand lifted by wind soils panels and built the ripples that trapped Opportunity and Spirit.",
      lim: "Not applicable on the Moon. Surface winds from Mars reanalysis are weakly constrained; lander values exist for a few sites only." },
    { n: "Closed depressions (craters)", ids: ["dep_frac"], tags: ["Terrain", "Moon and Mars"], play: "fill", what: "How much of the area sits in closed hollows, and how deep they are.",
      flow: ["Derived from the same elevation models as slope.", "Depression filling, then filled minus original.", "Match on area fraction and mean depth."],
      f: "depth = filled relief − relief;  f = share of pixels deeper than 10 m",
      why: "Craters are the main landing hazard and the main obstacle for rovers. At the lunar poles, rims are lit and floors hold ice.",
      lim: "Earth has about 190 confirmed impact craters, so crater density cannot be matched. This measures shape, not origin: calderas and sinkholes count too." },
    { n: "Absence of vegetation", ids: ["ndvi"], tags: ["Life", "Moon and Mars"], play: "ndvi", what: "Whether plants cover the ground, from the NDVI index.",
      flow: ["NASA MODIS records reflected sunlight in red and near-infrared. A passive sensor: it emits nothing.", "Annual maximum, median of 3 years, snow and water masked.", "Less is better: full score up to 0.1, zero from 0.2."],
      f: "NDVI = (NIR − Red) / (NIR + Red);  score = clip( (0.2 − NDVI) / 0.1, 0, 1 )",
      why: "Vegetation scatters radar, adds organic matter to the soil, and roots change how wheels sink.",
      lim: "Snow, ice and water also give low NDVI. NDVI sees plants only, not microbes." },
    { n: "Soil microbial life", ids: ["low_biomass"], tags: ["Life", "Moon and Mars"], play: "microbe", what: "An estimate of how close to lifeless the soil is.",
      flow: ["No global measurement exists. Inputs: aridity index, soil organic carbon, air temperature, plant growth.", "Each input scaled between fixed thresholds.", "Weighted sum. The direction flips for extremophile studies."],
      f: "score = 0.45·W + 0.30·C + 0.15·T + 0.10·V",
      why: "Life-detection instruments need a low background. NDVI can read zero over soil that is full of microbes.",
      lim: "A proxy, not a count, and the formula is our own proposal. No natural surface on Earth is sterile; confirming needs field sampling." },
    { n: "Soil moisture", ids: ["soil_moist"], tags: ["Water and ice", "Moon and Mars"], play: "moisture", what: "Water in the top 5 cm of soil. Also the proxy for radar transparency.",
      flow: ["NASA SMAP measures natural microwave emission at 1.4 GHz. Wet soil emits less.", "Multi-year mean, aggregated from 9 km to the grid.", "Less is better."],
      f: "score = clip( (0.10 − θ) / (0.10 − 0.02), 0, 1 )",
      why: "Liquid water absorbs radar. Ground-penetrating radar tests need dry soil, dry salt or frozen ground.",
      lim: "Thresholds are a proposal and need calibration on real data." },
  ];

  function playBox(id) {
    const p = PLAY[id];
    return `<div class="d-playbox" data-play="${id}">${p.ctl.map((k) => `<label class="d-ctl"><span>${k[1]}</span><input type="range" data-k="${k[0]}" min="${k[2]}" max="${k[3]}" step="${k[4]}" value="${k[5]}"><output></output></label>`).join("")}
      ${p.presets ? `<div class="d-presets">${p.presets.map((ps, i) => `<button data-preset="${i}">${ps[0]}</button>`).join("")}</div>` : ""}<div class="d-out"></div></div>`;
  }
  function runPlay(box) {
    const p = PLAY[box.dataset.play], v = {};
    box.querySelectorAll("input[type=range]").forEach((inp, i) => {
      v[inp.dataset.k] = +inp.value;
      const step = p.ctl[i][4];
      inp.nextElementSibling.textContent = (step < 0.01 ? (+inp.value).toFixed(3) : step < 1 ? String(+(+inp.value).toFixed(2)) : inp.value) + p.ctl[i][6];
    });
    box.querySelector(".d-out").innerHTML = p.run(v);
  }
  function plannedCard(c) {
    return `<article class="d-card">
      <div class="d-head"><div><h3>${c.n}</h3><p class="d-what">${c.what}</p></div>
        <div class="d-meta"><span class="d-tag is-planned">Planned · data not loaded yet</span>${c.tags.map((t) => `<span class="d-tag">${t}</span>`).join("")}</div></div>
      <div class="d-flow"><div><b>1 · Measured</b>${c.flow[0]}</div><div><b>2 · Processed</b>${c.flow[1]}</div><div><b>3 · Scored</b>${c.flow[2]}</div></div>
      <div class="d-body"><div class="d-play"><div class="d-play-h">Try the formula</div>${playBox(c.play)}</div>
        <div class="d-info"><div><h4>Formula</h4><code class="d-formula">${c.f}</code></div><div><h4>Why it matters</h4><p>${c.why}</p></div>
        <div class="d-limit"><h4>Where it stops being valid</h4><p>${c.lim}</p></div></div></div></article>`;
  }

  window.renderDocs = function () {
    const groups = [...new Set(S.criteria.map((c) => c.group))];
    // a planned criterion disappears from "Planned" as soon as its data is in criteria.json
    const planned = PLANNED.filter((p) => !p.ids.some((id) => S.criteria.some((c) => c.id === id)));
    if (group === null || (group === "Planned" ? !planned.length : !groups.includes(group))) group = groups[0];
    $("#d-tabs").innerHTML = groups.map((g) => { const n = S.criteria.filter((c) => c.group === g).length;
      return `<button class="d-tab" role="tab" data-dg="${esc(g)}" aria-selected="${g === group}"><b>${esc(g)}</b><span>${n} ${n > 1 ? "criteria" : "criterion"}</span></button>`; }).join("")
      + (planned.length ? `<button class="d-tab" role="tab" data-dg="Planned" aria-selected="${group === "Planned"}"><b>Planned</b><span>${planned.length} ${planned.length > 1 ? "criteria" : "criterion"}, data pending</span></button>` : "");
    $("#d-body").innerHTML = group === "Planned" ? planned.map(plannedCard).join("") : S.criteria.filter((c) => c.group === group).map(liveCard).join("");
    $$("#d-body .d-live").forEach(updateLive);
    $$("#d-body [data-play]").forEach(runPlay);
  };

  const root = $("#view-docs");
  root.addEventListener("input", (e) => {
    if (!e.target.matches("input[type=range]")) return;
    const pb = e.target.closest("[data-play]");
    if (pb) runPlay(pb); else updateLive(e.target.closest(".d-live"));
  });
  root.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-dg]");
    if (tab) { group = tab.dataset.dg; window.renderDocs(); return; }
    const set = e.target.closest("[data-set]");
    if (set) { const box = set.closest(".d-live"); box.querySelector("input").value = set.dataset.set; updateLive(box); return; }
    const pre = e.target.closest("[data-preset]");
    if (pre) {
      const box = pre.closest("[data-play]"), vals = PLAY[box.dataset.play].presets[+pre.dataset.preset][1];
      Object.keys(vals).forEach((k) => { box.querySelector(`input[data-k="${k}"]`).value = vals[k]; });
      runPlay(box);
    }
  });
})();
