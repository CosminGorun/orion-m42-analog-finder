"""Closed depressions (crater-like hollows) from the same elevation models used for slope.

The window is "flooded" until water would spill over its edge (depression filling). Filled minus
original relief is the depth of every closed hollow. The same code runs on ETOPO (Earth),
LOLA (Moon) and MOLA (Mars) windows at ~3.7 km, so values are comparable.
"""
import json
import numpy as np
from . import NLAT, NLON, ROOT

NAME = "depressions"
MIN_DEPTH = 10.0   # metres: shallower hollows are treated as noise

CRITERIA = [
    {
        "id": "dep_frac", "group": "Terrain", "name": "Closed depressions, area", "unit": "%", "decimals": 1, "weight": 1.0,
        "description": "Share of the ~50 km window that lies in closed hollows deeper than 10 m.",
        "earth_source": "Derived from NOAA ETOPO1, 2′ (~3.7 km)",
        "target_source": {"moon": "Derived from NASA LRO LOLA, ~3.6–3.8 km", "mars": "Derived from NASA MGS MOLA MEGDR 16 ppd (~3.7 km)"},
        "why": "Craters are the main landing hazard and the main obstacle for rovers.",
        "formula": "depth = filled relief − relief;  area = share of pixels with depth > 10 m",
        "limit": "Measures shape, not origin: calderas, sinkholes and dry basins count too. Only hollows wider than about 10 km are resolved.",
    },
    {
        "id": "dep_depth", "group": "Terrain", "name": "Closed depressions, depth", "unit": "m", "decimals": 0, "weight": 0.5,
        "description": "Mean depth of the closed hollows in the window (0 where there are none).",
        "earth_source": "Derived from NOAA ETOPO1, 2′ (~3.7 km)",
        "target_source": {"moon": "Derived from NASA LRO LOLA, ~3.6–3.8 km", "mars": "Derived from NASA MGS MOLA MEGDR 16 ppd (~3.7 km)"},
        "why": "Deep hollows mean steep inner walls, long shadows and cold floors.",
        "formula": "mean of (filled relief − relief) over pixels deeper than 10 m",
        "limit": "A hollow cut by the window edge counts as open, so very large basins are underestimated.",
    },
]


def fill(z: np.ndarray) -> np.ndarray:
    """Depression filling for a stack of windows (n, h, w): water may only leave through the window edge."""
    z = z.astype(np.float32)
    f = np.full_like(z, np.inf)
    f[:, 0, :], f[:, -1, :], f[:, :, 0], f[:, :, -1] = z[:, 0, :], z[:, -1, :], z[:, :, 0], z[:, :, -1]
    for _ in range(z.shape[1] * z.shape[2]):
        p = np.pad(f, ((0, 0), (1, 1), (1, 1)), constant_values=np.inf)
        m = np.minimum.reduce([p[:, 1 + di:1 + di + z.shape[1], 1 + dj:1 + dj + z.shape[2]]
                               for di in (-1, 0, 1) for dj in (-1, 0, 1)])
        g = np.maximum(z, m)
        g[:, 0, :], g[:, -1, :], g[:, :, 0], g[:, :, -1] = z[:, 0, :], z[:, -1, :], z[:, :, 0], z[:, :, -1]
        if np.array_equal(g, f):
            break
        f = g
    return f


def stats(z: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    depth = fill(z) - z
    deep = depth > MIN_DEPTH
    n = deep.sum(axis=(1, 2))
    frac = 100.0 * n / (z.shape[1] * z.shape[2])
    mean = np.where(n > 0, (depth * deep).sum(axis=(1, 2)) / np.maximum(n, 1), 0.0)
    return frac, mean


def fetch() -> None:
    pass


def earth() -> dict:
    import build_earth_grid as beg
    _, alt = beg.load_etopo()
    cells = np.array(json.loads((ROOT / "app" / "data" / "earth_grid.json").read_text(encoding="utf8"))["cells"])
    per = beg.PER
    frac = np.full((NLAT, NLON), np.nan)
    depth = np.full((NLAT, NLON), np.nan)
    for start in range(0, len(cells), 8000):
        part = cells[start:start + 8000]
        r, c = part // NLON, part % NLON
        z = np.stack([np.maximum(alt[i * per:(i + 1) * per, j * per:(j + 1) * per], 0) for i, j in zip(r, c)])
        f, d = stats(z)
        frac[r, c], depth[r, c] = f, d
    return {"dep_frac": frac, "dep_depth": depth}


_dems = {}


def target(t: dict) -> dict:
    import build_target as bt
    if t["body"] == "moon" and t["lat"] < -75:
        if "polar" not in _dems:
            _dems["polar"] = bt.lola()
        w = bt.lola_window(_dems["polar"], t["lat"], t["lon"], t["window_km"])
    elif t["body"] == "moon":
        if "lola16" not in _dems:
            _dems["lola16"] = np.fromfile(bt.LOLA16_FILE, dtype="<i2").reshape(2880, 5760).astype(np.float32) * 0.5
        w, _, _ = bt.global_window(_dems["lola16"], t["lat"], t["lon"], t["window_km"], bt.R_MOON, 2)
    else:
        if "mola" not in _dems:
            _dems["mola"] = np.fromfile(bt.MOLA16_FILE, dtype=">i2").reshape(2880, 5760).astype(np.float32)
        w, _, _ = bt.global_window(_dems["mola"], t["lat"], t["lon"], t["window_km"], bt.R_MARS, 1)
    f, d = stats(w[None])
    return {"dep_frac": float(f[0]), "dep_depth": float(d[0])}
