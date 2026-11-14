"""Calculeaza profilul zonei-tinta (Luna) pentru fiecare intrare din targets.json.

Relief : NASA LRO LOLA LDEM_75S_240M (raw/ldem_75s_240m.img), mediat la ~3,6 km
Termic : NASA LRO Diviner Polar Resource Product (doar portiunea din jurul tintei,
         descarcata prin cereri HTTP Range din fisierul de 605 MB)
Iesire : app/data/targets.json

Rulare:  python pipeline/build_target.py
"""
from pathlib import Path
import json
import time
import numpy as np
import requests

from common import terrain_stats, low_sun_fraction
from criteria import CRITERIA, LIMITS

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "app" / "data"
OUT.mkdir(parents=True, exist_ok=True)

R_MOON = 1737.4  # km

# --- LOLA -----------------------------------------------------------------
LOLA_FILE = RAW / "ldem_75s_240m.img"
LOLA_N = 3812
LOLA_SCALE = 240.0            # m/pixel
LOLA_OFFSET = 1905.5          # LINE/SAMPLE_PROJECTION_OFFSET
LOLA_DN = 0.5                 # metri per unitate
BLOCK = 15                    # 15 x 240 m = 3,6 km, apropiat de pasul ETOPO (~3,7 km)


def lola() -> np.ndarray:
    a = np.fromfile(LOLA_FILE, dtype="<i2").reshape(LOLA_N, LOLA_N)
    return a.astype(np.float32) * LOLA_DN


def polar_xy(lat: float, lon: float) -> tuple[float, float]:
    """Proiectie stereografica polara sud (sfera), in metri."""
    rho = 2 * R_MOON * 1000 * np.tan(np.pi / 4 + np.radians(lat) / 2)
    return rho * np.sin(np.radians(lon)), rho * np.cos(np.radians(lon))


def lola_pixel(lat: float, lon: float) -> tuple[float, float]:
    x, y = polar_xy(lat, lon)
    sample = LOLA_OFFSET + x / LOLA_SCALE
    line = LOLA_OFFSET - y / LOLA_SCALE
    return line, sample


def lola_window(dem: np.ndarray, lat: float, lon: float, window_km: float) -> np.ndarray:
    """Fereastra in jurul tintei, mediata in blocuri de BLOCK x BLOCK pixeli."""
    line, sample = lola_pixel(lat, lon)
    half = int(round(window_km * 1000 / 2 / (LOLA_SCALE * BLOCK))) * BLOCK
    l0, s0 = int(round(line)) - half, int(round(sample)) - half
    w = dem[l0:l0 + 2 * half, s0:s0 + 2 * half]
    n = w.shape[0] // BLOCK
    return w[:n * BLOCK, :n * BLOCK].reshape(n, BLOCK, n, BLOCK).mean(axis=(1, 3))


# --- Diviner ----------------------------------------------------------------
PRP_URL = ("https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/"
           "data_derived_prp/dlre_prp_south.tab")
PRP_HEADER, PRP_ROW, PRP_GRID = 210, 210, 1200
PRP_X0, PRP_STEP = 299.52036, 599.04072 / 1199


def _range(session: requests.Session, start: int, end: int) -> str:
    for attempt in range(6):
        try:
            r = session.get(PRP_URL, headers={"Range": f"bytes={start}-{end}"}, timeout=90)
            r.raise_for_status()
            return r.text
        except requests.RequestException as e:
            print(f"    reincercare {attempt + 1}: {type(e).__name__}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("Diviner indisponibil")


def diviner_window(lat: float, lon: float, window_km: float) -> dict:
    """Temperaturi si adancimea ghetii din triunghiurile Diviner din fereastra."""
    r = R_MOON * np.cos(np.radians(lat))
    xc, yc = r * np.cos(np.radians(lon)), r * np.sin(np.radians(lon))
    half = window_km / 2
    i0 = int((PRP_X0 - (xc + half)) / PRP_STEP) - 1
    i1 = int((PRP_X0 - (xc - half)) / PRP_STEP) + 1
    j0 = int(((yc - half) + PRP_X0) / PRP_STEP) - 1
    j1 = int(((yc + half) + PRP_X0) / PRP_STEP) + 1
    print(f"  Diviner: {i1 - i0 + 1} randuri de grid, descarcare partiala...")
    rows = []
    with requests.Session() as s:
        for i in range(i0, i1 + 1):
            first = (i * PRP_GRID + j0) * 2
            last = (i * PRP_GRID + j1) * 2 + 1
            txt = _range(s, PRP_HEADER + first * PRP_ROW, PRP_HEADER + (last + 1) * PRP_ROW - 1)
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


def main() -> None:
    targets = json.loads((Path(__file__).parent / "targets.json").read_text(encoding="utf8"))
    dem = lola()
    out = []
    for t in targets:
        if t["body"] != "moon":
            print(f"[skip] {t['name']}: deocamdata doar tinte lunare")
            continue
        print(f"[tinta] {t['name']} ({t['lat']}, {t['lon']})")
        w = lola_window(dem, t["lat"], t["lon"], t["window_km"])
        px = LOLA_SCALE * BLOCK
        ter = terrain_stats(w, px, px)
        cache = RAW / f"diviner_{t['id']}_{t['window_km']}km.json"
        if cache.exists():
            div = json.loads(cache.read_text(encoding="utf8"))
        else:
            div = diviner_window(t["lat"], t["lon"], t["window_km"])
            cache.write_text(json.dumps(div), encoding="utf8")
        print(f"  LOLA fereastra {w.shape}, Diviner {div['n']} triunghiuri")

        values = {
            "slope_mean": ter["slope_mean"],
            "slope_p90": ter["slope_p90"],
            "relief": ter["relief"],
            "roughness": ter["roughness"],
            "t_mean": div["t_avg_K"] - 273.15,
            "t_max": div["t_max_K"] - 273.15,
            "precip": 0.0,
            "low_sun": low_sun_fraction(round(t["lat"], 2), 1.54),
            "pressure": 0.0,
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
        out.append({**t, "values": values, "extra": extra, "limits": LIMITS["moon"]})
        for k, v in values.items():
            print(f"    {k:10s} {v:10.2f}")

    (OUT / "targets.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf8")
    (OUT / "criteria.json").write_text(json.dumps(CRITERIA, ensure_ascii=False, indent=1), encoding="utf8")
    print("scris", OUT / "targets.json")


if __name__ == "__main__":
    main()
