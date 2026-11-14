"""Builds the profile of every target site in targets.json.

Three kinds of target:
  - lunar south pole (lat < -75): relief from LOLA LDEM_75S_240M, temperatures and ice
    from the Diviner Polar Resource Product (only the window around the target is read
    with HTTP Range requests from the 605 MB file)
  - lunar pits elsewhere: relief from LOLA LDEM_16, temperatures from the Diviner Global
    Cumulative Product (3 x 3 tiles of 0.5°, 96 local-time bins, read with HTTP Range)
  - Mars: relief from MOLA MEGDR 16 ppd, pressure estimated from elevation

Output: app/data/targets.json and app/data/criteria.json

Run:  python pipeline/build_target.py
"""
from pathlib import Path
import json
import time
import numpy as np
import requests

from common import terrain_stats, low_sun_fraction
from criteria import CRITERIA, LIMITS, SUBSURFACE_NOTES

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "app" / "data"
OUT.mkdir(parents=True, exist_ok=True)

R_MOON = 1737.4  # km
R_MARS = 3389.5  # km

# --- LOLA south pole (polar stereographic) --------------------------------
LOLA_FILE = RAW / "ldem_75s_240m.img"
LOLA_N = 3812
LOLA_SCALE = 240.0            # m/pixel
LOLA_OFFSET = 1905.5          # LINE/SAMPLE_PROJECTION_OFFSET
LOLA_DN = 0.5                 # metres per DN
BLOCK = 15                    # 15 x 240 m = 3.6 km, close to the ETOPO step (~3.7 km)


def lola() -> np.ndarray:
    a = np.fromfile(LOLA_FILE, dtype="<i2").reshape(LOLA_N, LOLA_N)
    return a.astype(np.float32) * LOLA_DN


def polar_xy(lat: float, lon: float) -> tuple[float, float]:
    """South polar stereographic projection (sphere), metres."""
    rho = 2 * R_MOON * 1000 * np.tan(np.pi / 4 + np.radians(lat) / 2)
    return rho * np.sin(np.radians(lon)), rho * np.cos(np.radians(lon))


def lola_pixel(lat: float, lon: float) -> tuple[float, float]:
    x, y = polar_xy(lat, lon)
    return LOLA_OFFSET - y / LOLA_SCALE, LOLA_OFFSET + x / LOLA_SCALE


def lola_window(dem: np.ndarray, lat: float, lon: float, window_km: float) -> np.ndarray:
    """Window around the target, averaged in BLOCK x BLOCK pixel blocks."""
    line, sample = lola_pixel(lat, lon)
    half = int(round(window_km * 1000 / 2 / (LOLA_SCALE * BLOCK))) * BLOCK
    l0, s0 = int(round(line)) - half, int(round(sample)) - half
    w = dem[l0:l0 + 2 * half, s0:s0 + 2 * half]
    n = w.shape[0] // BLOCK
    return w[:n * BLOCK, :n * BLOCK].reshape(n, BLOCK, n, BLOCK).mean(axis=(1, 3))


# --- Global cylindrical DEMs (16 px/deg): LOLA LDEM_16, MOLA MEGDR ---------
LOLA16_FILE = RAW / "ldem_16.img"
MOLA16_FILE = RAW / "megt90n000eb.img"
PPD = 16


def global_window(dem: np.ndarray, lat: float, lon: float, window_km: float, radius_km: float, block: int):
    """Window from a global cylindrical DEM (row 0 = 90°N, column 0 = 0°E), averaged in blocks.

    Returns (window, dx_m, dy_m) — pixel spacing in metres after averaging.
    """
    km_per_px = np.pi * radius_km / 180 / PPD
    half_r = int(round(window_km / 2 / km_per_px / block)) * block
    half_c = int(round(window_km / 2 / (km_per_px * np.cos(np.radians(lat))) / block)) * block
    r0 = int(round((90 - lat) * PPD)) - half_r
    c0 = int(round((lon % 360) * PPD)) - half_c
    cols = np.arange(c0, c0 + 2 * half_c) % dem.shape[1]
    w = dem[r0:r0 + 2 * half_r][:, cols]
    nr, nc = w.shape[0] // block, w.shape[1] // block
    w = w[:nr * block, :nc * block].reshape(nr, block, nc, block).mean(axis=(1, 3))
    dy = km_per_px * block * 1000
    return w, dy * np.cos(np.radians(lat)), dy


# --- Diviner Polar Resource Product -----------------------------------------
PRP_URL = ("https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/"
           "data_derived_prp/dlre_prp_south.tab")
PRP_HEADER, PRP_ROW, PRP_GRID = 210, 210, 1200
PRP_X0, PRP_STEP = 299.52036, 599.04072 / 1199


def _get_range(session: requests.Session, url: str, start: int, end: int) -> str:
    for attempt in range(6):
        try:
            r = session.get(url, headers={"Range": f"bytes={start}-{end}"}, timeout=90)
            r.raise_for_status()
            return r.text
        except requests.RequestException as e:
            print(f"    retry {attempt + 1}: {type(e).__name__}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"Diviner unavailable: {url}")


def diviner_window(lat: float, lon: float, window_km: float) -> dict:
    """Temperatures and ice depth from the Diviner PRP facets inside the window."""
    r = R_MOON * np.cos(np.radians(lat))
    xc, yc = r * np.cos(np.radians(lon)), r * np.sin(np.radians(lon))
    half = window_km / 2
    i0 = int((PRP_X0 - (xc + half)) / PRP_STEP) - 1
    i1 = int((PRP_X0 - (xc - half)) / PRP_STEP) + 1
    j0 = int(((yc - half) + PRP_X0) / PRP_STEP) - 1
    j1 = int(((yc + half) + PRP_X0) / PRP_STEP) + 1
    print(f"  Diviner PRP: {i1 - i0 + 1} grid rows, partial download...")
    rows = []
    with requests.Session() as s:
        for i in range(i0, i1 + 1):
            first = (i * PRP_GRID + j0) * 2
            last = (i * PRP_GRID + j1) * 2 + 1
            txt = _get_range(s, PRP_URL, PRP_HEADER + first * PRP_ROW, PRP_HEADER + (last + 1) * PRP_ROW - 1)
            for line in txt.splitlines():
                v = line.split(",")
                if len(v) != 15:
                    continue
                x, y = float(v[0]), float(v[1])
                if abs(x - xc) <= half and abs(y - yc) <= half:
                    rows.append((float(v[12]), float(v[13]), float(v[14])))  # temp_avg, temp_max, ice_depth
    a = np.array(rows)
    t_avg, t_max, ice = a[:, 0], a[:, 1], a[:, 2]
    ice_ok = (ice >= 0) & (ice < 1.0)
    return {
        "n": int(a.shape[0]),
        "t_avg_K": float(t_avg.mean()),
        "t_max_K": float(np.percentile(t_max, 50)),
        "t_max_K_p95": float(np.percentile(t_max, 95)),
        "t_avg_K_min": float(t_avg.min()),
        "ice_fraction": float(ice_ok.mean()),
    }


# --- Diviner Global Cumulative Product (0.5° tiles, 96 local-time bins) -----
GCP_URL = ("https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/"
           "data_derived_gcp/global_cumul_avg_cyl_{band}_002.tab")
GCP_ROW = 113          # bytes per row (header row has the same length)
GCP_LATS = 20          # 0.5° tiles per 10° band


def _band(lat: float) -> tuple[str, int]:
    lo = int(np.floor(lat / 10) * 10)
    south = lo < 0
    tag = lambda v: f"{abs(v):02d}{'s' if south else 'n'}"
    return tag(lo) + tag(lo + 10), lo


def diviner_gcp(lat: float, lon: float, tiles: int = 3) -> dict:
    """Mean diurnal temperature curve over tiles x tiles cells of 0.5° around the target."""
    band, lo = _band(lat)
    url = GCP_URL.format(band=band)
    lon180 = ((lon + 180) % 360) - 180
    li0 = int((lon180 + 180) / 0.5) - tiles // 2
    la0 = int((lat - lo) / 0.5) - tiles // 2
    curves = []
    print(f"  Diviner GCP: band {band}, {tiles}x{tiles} tiles, partial download...")
    with requests.Session() as s:
        for li in range(li0, li0 + tiles):
            for la in range(la0, la0 + tiles):
                if not 0 <= la < GCP_LATS:
                    continue
                first = ((li % 720) * GCP_LATS + la) * 96
                start = GCP_ROW + first * GCP_ROW
                txt = _get_range(s, url, start, start + 96 * GCP_ROW - 1)
                rows = [l.split(",") for l in txt.splitlines() if l.count(",") == 10]
                clon, clat = float(rows[0][0]), float(rows[0][1])
                want_lat = lo + (la + 0.5) * 0.5
                want_lon = -180 + ((li % 720) + 0.5) * 0.5
                if abs(clat - want_lat) > 1e-3 or abs(clon - want_lon) > 1e-3:
                    raise RuntimeError(f"Unexpected GCP tile order: got {clat},{clon}, wanted {want_lat},{want_lon}")
                tb = np.array([float(r[10]) for r in rows])
                tb[tb < 0] = np.nan
                curves.append(tb)
    curve = np.nanmean(np.array(curves), axis=0)
    return {"t_max_K": float(np.nanmax(curve)), "t_min_K": float(np.nanmin(curve)),
            "t_mean_K": float(np.nanmean(curve)), "tiles": len(curves), "band": band}


def cached(name: str, fn):
    path = RAW / name
    if path.exists():
        return json.loads(path.read_text(encoding="utf8"))
    v = fn()
    path.write_text(json.dumps(v), encoding="utf8")
    return v


# --- builders per target kind ---------------------------------------------
def build_polar(t: dict, dem: np.ndarray) -> tuple[dict, dict]:
    w = lola_window(dem, t["lat"], t["lon"], t["window_km"])
    px = LOLA_SCALE * BLOCK
    ter = terrain_stats(w, px, px)
    div = cached(f"diviner_{t['id']}_{t['window_km']}km.json", lambda: diviner_window(t["lat"], t["lon"], t["window_km"]))
    values = {
        **{k: ter[k] for k in ("slope_mean", "slope_p90", "relief", "roughness")},
        "t_mean": div["t_avg_K"] - 273.15, "t_max": div["t_max_K"] - 273.15,
        "precip": 0.0, "low_sun": low_sun_fraction(round(t["lat"], 2), 1.54), "pressure": 0.0,
        "ice": 1 if div["ice_fraction"] > 0 else 0,
    }
    extra = {
        "Mean elevation (LOLA)": f"{ter['elev_mean']:,.0f} m above the 1,737.4 km reference radius",
        "Coldest mean temperature in window (Diviner)": f"{div['t_avg_K_min'] - 273.15:.0f} °C",
        "Maximum temperature, 95th percentile (Diviner)": f"{div['t_max_K_p95'] - 273.15:.0f} °C",
        "Area with ice stable within 1 m (Diviner)": f"{100 * div['ice_fraction']:.1f}% of window",
        "Diviner facets used": f"{div['n']:,}",
        "LOLA cells used": f"{w.shape[0]} × {w.shape[1]} (each ~{px / 1000:.1f} km)",
    }
    return values, extra


def build_moon_pit(t: dict, dem16: np.ndarray) -> tuple[dict, dict]:
    w, dx, dy = global_window(dem16, t["lat"], t["lon"], t["window_km"], R_MOON, 2)
    ter = terrain_stats(w, dx, dy)
    div = cached(f"diviner_gcp_{t['id']}.json", lambda: diviner_gcp(t["lat"], t["lon"]))
    values = {
        **{k: ter[k] for k in ("slope_mean", "slope_p90", "relief", "roughness")},
        "t_max": div["t_max_K"] - 273.15, "t_swing": div["t_max_K"] - div["t_min_K"],
        "precip": 0.0, "low_sun": low_sun_fraction(round(t["lat"], 2), 1.54), "pressure": 0.0,
        "basalt_dist": 0.0,
    }
    values.update(t.get("literature", {}))
    extra = {
        "Pit (LROC catalog)": t.get("pit_size", "—"),
        "Mean surface elevation (LOLA)": f"{ter['elev_mean']:,.0f} m above the 1,737.4 km reference radius",
        "Surface temperature range (Diviner)": f"{div['t_min_K'] - 273.15:.0f} °C to {div['t_max_K'] - 273.15:.0f} °C",
        "Diurnal mean surface temperature (Diviner)": f"{div['t_mean_K'] - 273.15:.0f} °C",
        "Diviner tiles used": f"{div['tiles']} × 0.5° (band {div['band']})",
        "LOLA cells used": f"{w.shape[0]} × {w.shape[1]} (each ~{dy / 1000:.1f} km)",
    }
    return values, extra


def build_mars_pit(t: dict, mola: np.ndarray) -> tuple[dict, dict]:
    w, dx, dy = global_window(mola, t["lat"], t["lon"], t["window_km"], R_MARS, 1)
    ter = terrain_stats(w, dx, dy)
    pressure = 6.1 * np.exp(-ter["elev_mean"] / 11100.0)
    values = {
        **{k: ter[k] for k in ("slope_mean", "slope_p90", "relief", "roughness")},
        "precip": 0.0, "low_sun": low_sun_fraction(round(t["lat"], 2), 25.19), "pressure": float(pressure),
        "basalt_dist": 0.0,
    }
    values.update(t.get("literature", {}))
    extra = {
        "Skylight (Mars cave catalog)": t.get("pit_size", "—"),
        "Mean elevation (MOLA)": f"{ter['elev_mean']:,.0f} m above the Mars datum",
        "Estimated surface pressure": f"{pressure:.1f} hPa",
        "Thermal data": "Not yet included for Mars targets",
        "MOLA cells used": f"{w.shape[0]} × {w.shape[1]} (each ~{dy / 1000:.1f} km)",
    }
    return values, extra


def main() -> None:
    targets = json.loads((Path(__file__).parent / "targets.json").read_text(encoding="utf8"))
    polar = lola() if LOLA_FILE.exists() else None
    lola16 = np.fromfile(LOLA16_FILE, dtype="<i2").reshape(2880, 5760).astype(np.float32) * 0.5 if LOLA16_FILE.exists() else None
    mola = np.fromfile(MOLA16_FILE, dtype=">i2").reshape(2880, 5760).astype(np.float32) if MOLA16_FILE.exists() else None
    out = []
    for t in targets:
        print(f"[target] {t['name']} ({t['lat']}, {t['lon']})")
        if t["body"] == "moon" and t["lat"] < -75:
            values, extra = build_polar(t, polar)
        elif t["body"] == "moon":
            values, extra = build_moon_pit(t, lola16)
        elif t["body"] == "mars":
            if mola is None:
                print("  [skip] MOLA file missing")
                continue
            values, extra = build_mars_pit(t, mola)
        else:
            raise ValueError(t["body"])
        # criteria a target does not define are "not applicable" (null) and are left out of its score
        values = {c["id"]: (None if values.get(c["id"]) is None else float(values[c["id"]])) for c in CRITERIA}
        entry = {**t, "values": values, "extra": extra, "limits": LIMITS[t["body"]]}
        if t.get("kind") == "subsurface":
            entry["notes_subsurface"] = SUBSURFACE_NOTES
        out.append(entry)
        for k, v in values.items():
            print(f"    {k:12s} {'n/a' if v is None else round(v, 2)}")

    (OUT / "targets.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf8")
    (OUT / "criteria.json").write_text(json.dumps(CRITERIA, ensure_ascii=False, indent=1), encoding="utf8")
    print("written", OUT / "targets.json")


if __name__ == "__main__":
    main()
