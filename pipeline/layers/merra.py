"""NASA MERRA-2 reanalysis (GES DISC): dust in the air, dust storms, near-surface wind, soil moisture.

Downloads only the needed variables through OPeNDAP (opendap.earthdata.nasa.gov, DAP4 constraint):

  M2TMNXAER  DUEXTTAU         monthly, 2020-2024        -> dust
  M2T1NXAER  DUEXTTAU         hourly, every 6th hour (00:30, 06:30, 12:30, 18:30 UTC), demo sample of
                              MAX_DAYS = 114 days (2024-01-01 .. 2024-04-23) -> daily means -> dust_storm
  M2TMNXFLX  SPEED, SPEEDMAX  monthly, 2020-2024        -> wind
  M2TMNXLND  SFMC             monthly, 2020-2024        -> soil_moist
  M2TMNXSLV  T2M              monthly, 2020-2024        -> t2m (cached only, read by another layer)

Authentication: NASA Earthdata Bearer token from D:\\alba\\.earthdata_token (or EARTHDATA_TOKEN).
The token is never printed. Results are cached in raw/layers/merra/merra.npz.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import os
import re
import time
import numpy as np
from . import RAW, ROOT, NLAT, NLON, to_grid

NAME = "merra"
DIR = RAW / NAME
CACHE = DIR / "merra.npz"
TARGET_VALUES = Path(__file__).resolve().parent / "target_values.json"

CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
OPENDAP = "https://opendap.earthdata.nasa.gov/collections/{cid}/granules/{gid}"
MONTHLY = "2020-01-01T00:00:00Z,2024-12-31T23:59:59Z"
DAILY_YEARS = [2024]
MAX_DAYS = 114                                      # demo sample: 2024-01-01 .. 2024-04-23, not a full year
HOUR_STRIDE = 6
SAMPLE = "114 days, 2024-01-01 to 2024-04-23"
NY, NX = 361, 576                                   # MERRA-2: 0.5° x 0.625°, south first, lon from -180

PRODUCTS = {
    "M2TMNXAER": {"cid": "C1276812866-GES_DISC", "vars": ["DUEXTTAU"], "nt": 1},
    "M2T1NXAER": {"cid": "C1276812830-GES_DISC", "vars": ["DUEXTTAU"], "nt": 24},
    "M2TMNXFLX": {"cid": "C1276812868-GES_DISC", "vars": ["SPEED", "SPEEDMAX"], "nt": 1},
    "M2TMNXLND": {"cid": "C1276812856-GES_DISC", "vars": ["SFMC"], "nt": 1},
    "M2TMNXSLV": {"cid": "C1276812859-GES_DISC", "vars": ["T2M"], "nt": 1},
}

LIC = "NASA MERRA-2 (GMAO, distributed by GES DISC): US government data, public domain, no restrictions"
REANALYSIS = ("MERRA-2 is a reanalysis: a global model corrected with observations, not a direct measurement, "
              "on a ~50 km grid that smooths local extremes.")
MARS_DUST = "Mars Climate Database / orbiter dust opacity at the target (see target_values.json)"

CRITERIA = [
    {
        "id": "dust", "group": "Atmosphere", "name": "Dust in the air, normal conditions", "unit": "τ", "decimals": 2,
        "weight": 1.0, "mode": "match", "bodies": ["mars"], "scenario": "normal",
        "description": "Mean dust optical depth at 550 nm, 2020–2024: how much sunlight the airborne dust blocks.",
        "earth_source": "NASA MERRA-2 M2TMNXAER (monthly aerosol diagnostics), DUEXTTAU, mean 2020–2024",
        "target_source": {"moon": "Not applicable: no atmosphere", "mars": MARS_DUST},
        "why": "Dust in the air cuts solar power, coats optics and radiators, and sets how much abrasion hardware sees.",
        "formula": "mean of 60 monthly DUEXTTAU values (dust extinction optical thickness, 550 nm)",
        "limit": "Mars typically has τ ≈ 0.3–1 from dust alone in clear seasons. " + REANALYSIS,
        "licence": LIC,
    },
    {
        "id": "dust_storm", "group": "Atmosphere", "name": "Dust storms", "unit": "", "decimals": 2,
        "weight": 1.0, "mode": "higher", "lo": 0, "hi": 1, "bodies": ["mars"], "scenario": "storm",
        "description": "0–1 index of how often, how long and how densely thick dust fills the air, from daily dust "
                       f"optical depth over a sample of {SAMPLE} (MERRA-2 hourly fields sampled every 6 hours). "
                       "A sample, not a full year: days per year are scaled as (days above 0.5 / 114) × 365.",
        "earth_source": "NASA MERRA-2 M2T1NXAER (hourly aerosol diagnostics), DUEXTTAU at 00:30/06:30/12:30/18:30 UTC, "
                        f"daily means, {SAMPLE}",
        "target_source": {"moon": "Not applicable: no atmosphere",
                          "mars": "Higher is better: the most storm-prone Earth sites are the best stand-ins"},
        "why": "Long, dense dust events are the closest Earth gets to testing solar power loss, dust ingress and "
               "seal wear under a Martian storm.",
        "formula": "0.30·min(P95/2.0,1) + 0.30·min(days with τ>0.5 / 120,1) + 0.25·min(longest run of days "
                   "with τ>0.5 / 15,1) + 0.15·min(mean/0.6,1), τ = daily mean dust optical depth",
        "limit": "Earth dust storms reach optical depth 3–5 for hours to days; the 2018 Mars global storm reached "
                 f"10.8 and lasted months. Built from a {SAMPLE} sample, not a full year: it misses the "
                 "northern summer dust season (Sahel, Arabia, Taklamakan peak in spring-summer), so P95, "
                 "longest run and scaled days per year are biased for those regions; 6-hourly sampling can miss "
                 "short peaks. " + REANALYSIS,
        "licence": LIC,
    },
    {
        "id": "wind", "group": "Atmosphere", "name": "Wind, force-equivalent", "unit": "m/s", "decimals": 1,
        "weight": 0.5, "mode": "match", "bodies": ["mars"],
        "description": "Near-surface wind speed on Earth, 2020–2024 mean of the monthly SPEEDMAX field (time-mean of "
                       "the hourly maximum surface wind speed), compared with the Mars wind scaled to the same push.",
        "earth_source": "NASA MERRA-2 M2TMNXFLX (monthly surface fluxes), SPEEDMAX, mean 2020–2024",
        "target_source": {"moon": "Not applicable: no atmosphere",
                          "mars": "Mars wind speed (target_values.json) × 0.12 = Earth wind with the same dynamic pressure"},
        "why": "Wind load on masts, panels and parachutes depends on dynamic pressure, so the Mars wind must be "
               "converted before it can be matched to an Earth site.",
        "formula": "Earth: mean of monthly SPEEDMAX; Mars target: v_Mars · sqrt(ρ_Mars/ρ_Earth) ≈ 0.12 · v_Mars",
        "limit": "A 100 km/h Mars wind pushes like about 11–13 km/h on Earth because the air is 60–80 times thinner; "
                 "sand lifting and abrasion do not scale the same way. " + REANALYSIS,
        "licence": LIC,
    },
    {
        "id": "soil_moist", "group": "Water and ice", "name": "Soil moisture", "unit": "m³/m³", "decimals": 3,
        "weight": 0.5, "mode": "lower", "lo": 0.02, "hi": 0.10, "bodies": ["moon", "mars"],
        "description": "Mean volumetric water content of the surface soil layer (top ~5 cm), 2020–2024.",
        "earth_source": "NASA MERRA-2 M2TMNXLND (monthly land surface diagnostics), SFMC, mean 2020–2024",
        "target_source": {"moon": "Effectively 0: no liquid water in the regolith",
                          "mars": "Effectively 0: no liquid water in the surface regolith"},
        "why": "Wet soil changes traction, dust behaviour and how instruments see the ground; dry sites behave "
               "most like regolith.",
        "formula": "mean of 60 monthly SFMC values (m³ water per m³ soil, surface layer)",
        "limit": "Model soil moisture over deserts is poorly constrained by observations and has a floor set by the "
                 "land model; it ignores ice below the surface. " + REANALYSIS,
        "licence": LIC,
    },
]


# ---------------------------------------------------------------- download

def _token() -> str:
    t = os.environ.get("EARTHDATA_TOKEN")
    f = ROOT / ".earthdata_token"
    if not t and f.exists():
        t = f.read_text(encoding="utf8").strip()
    if not t:
        raise RuntimeError("Missing NASA Earthdata token: save it in D:\\alba\\.earthdata_token")
    return t


def _session():
    import requests
    s = requests.Session()
    s.headers["Authorization"] = f"Bearer {_token()}"
    return s


def _granules(cid: str, temporal: str) -> list[str]:
    import requests
    r = requests.get(CMR, params={"collection_concept_id": cid, "temporal": temporal, "page_size": 2000}, timeout=120)
    r.raise_for_status()
    return [e["title"] for e in r.json()["feed"]["entry"]]


def _get(session, url: str, **kw):
    import requests
    for attempt in range(6):
        try:
            r = session.get(url, timeout=300, **kw)
            if r.status_code in (401, 403):
                raise PermissionError(f"Access denied ({r.status_code}): check the Earthdata token and the "
                                      "'NASA GESDISC DATA ARCHIVE' application approval")
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            print(f"    retry {attempt + 1}: {type(e).__name__}")
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed: {url.split('?')[0]}")


def _download(short: str, temporal: str, stride: int = 1, workers: int = 6, limit: int | None = None) -> list[Path]:
    p = PRODUCTS[short]
    out = DIR / short
    out.mkdir(parents=True, exist_ok=True)
    titles = sorted(_granules(p["cid"], temporal))[:limit]
    nt = p["nt"]
    tsel = f"[0:{stride}:{nt - 1}]"
    ce = ";".join(f"/{v}{tsel}[0:1:{NY - 1}][0:1:{NX - 1}]" for v in p["vars"])
    s = _session()

    def one(title: str) -> Path:
        dest = out / re.sub(r"[^A-Za-z0-9._-]", "_", title)
        if dest.exists() and dest.stat().st_size > 0:
            return dest
        base = OPENDAP.format(cid=p["cid"], gid=__import__("requests").utils.quote(title, safe=""))
        r = _get(s, base + ".dap.nc4", params={"dap4.ce": ce})
        tmp = dest.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.replace(dest)
        return dest

    with ThreadPoolExecutor(workers) as ex:
        paths = list(ex.map(one, titles))
    mb = sum(f.stat().st_size for f in paths) / 1e6
    print(f"  [{short}] {len(paths)} files, {mb:.0f} MB")
    return paths


def _read(path: Path, var: str) -> np.ndarray:
    import netCDF4
    with netCDF4.Dataset(path) as d:
        a = np.ma.filled(d[var][:].astype(np.float64), np.nan)
    a[np.abs(a) > 1e14] = np.nan
    return a.reshape(-1, NY, NX)


def _monthly_mean(paths: list[Path], var: str) -> np.ndarray:
    s = np.zeros((NY, NX))
    n = np.zeros((NY, NX))
    for f in paths:
        for a in _read(f, var):
            ok = np.isfinite(a)
            s[ok] += a[ok]
            n[ok] += 1
    return np.where(n > 0, s / np.maximum(n, 1), np.nan)


def _storm(paths: list[Path]) -> dict:
    daily = np.stack([np.nanmean(_read(f, "DUEXTTAU"), axis=0) for f in paths]).astype(np.float32)
    thick = daily > 0.5
    run = np.zeros((NY, NX), dtype=np.int32)
    longest = np.zeros((NY, NX), dtype=np.int32)
    for m in thick:
        run = np.where(m, run + 1, 0)
        np.maximum(longest, run, out=longest)
    p95 = np.percentile(daily, 95, axis=0)
    days = thick.sum(axis=0) / len(paths) * 365          # scaled from the sample to days per year
    mean = daily.mean(axis=0)
    idx = (0.30 * np.minimum(p95 / 2.0, 1) + 0.30 * np.minimum(days / 120, 1)
           + 0.25 * np.minimum(longest / 15, 1) + 0.15 * np.minimum(mean / 0.6, 1))
    return {"dust_storm": idx, "storm_p95": p95, "storm_days_per_year": days,
            "storm_longest_run": longest.astype(np.float64), "storm_daily_mean": mean}


def fetch() -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    aer = _download("M2TMNXAER", MONTHLY)
    flx = _download("M2TMNXFLX", MONTHLY)
    lnd = _download("M2TMNXLND", MONTHLY)
    slv = _download("M2TMNXSLV", MONTHLY)
    hourly = []
    for y in DAILY_YEARS:
        hourly += _download("M2T1NXAER", f"{y}-01-01T00:00:00Z,{y}-12-31T23:59:59Z", stride=HOUR_STRIDE, workers=8,
                            limit=MAX_DAYS - len(hourly))
        if len(hourly) >= MAX_DAYS:
            break
    if CACHE.exists() and CACHE.stat().st_mtime > max(f.stat().st_mtime for f in aer + flx + lnd + slv + hourly):
        return
    native = {
        "dust": _monthly_mean(aer, "DUEXTTAU"),
        "wind": _monthly_mean(flx, "SPEEDMAX"),
        "wind_mean_speed": _monthly_mean(flx, "SPEED"),
        "soil_moist": _monthly_mean(lnd, "SFMC"),
        "t2m": _monthly_mean(slv, "T2M") - 273.15,
        **_storm(hourly),
    }
    out = {k: to_grid(v, south_first=True, lon0=-180.0) for k, v in native.items()}
    tmp = DIR / "merra.tmp.npz"
    np.savez_compressed(tmp, **out, daily_years=np.array(DAILY_YEARS), hour_stride=np.array(HOUR_STRIDE))
    tmp.replace(CACHE)
    print(f"  saved {CACHE}")


# ---------------------------------------------------------------- layer API

def earth() -> dict:
    if not CACHE.exists():
        raise FileNotFoundError(f"{CACHE} is missing: run fetch() (python pipeline/build_layers.py --fetch)")
    with np.load(CACHE) as z:
        out = {c["id"]: z[c["id"]].astype(np.float64) for c in CRITERIA}
    for a in out.values():
        assert a.shape == (NLAT, NLON)
    return out


def target(t: dict) -> dict:
    if t.get("body") != "mars":
        return {"dust": None, "dust_storm": None, "wind": None, "soil_moist": 0.0}
    v = {}
    if TARGET_VALUES.exists():
        try:
            v = json.loads(TARGET_VALUES.read_text(encoding="utf8")).get(t["id"]) or {}
        except (ValueError, OSError):
            v = {}
    tau, w = v.get("dust_tau"), v.get("wind_ms")
    return {"dust": None if tau is None else float(tau),
            "dust_storm": 1.0,
            "wind": None if w is None else 0.12 * float(w),
            "soil_moist": 0.0}
