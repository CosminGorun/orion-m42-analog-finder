"""Calculeaza criteriile pentru fiecare celula de 0,5° de pe uscatul Pamantului.

Intrari : raw/etopo_*.nc (NOAA ETOPO1), raw/nasa/modis_lst_*.nc4 (NASA MODIS MOD11C3),
          raw/nasa/gpm_precip_*.nc4 (NASA GPM IMERG)
Iesire  : app/data/earth_grid.json

Rulare:  python pipeline/build_earth_grid.py
"""
from datetime import datetime, timedelta
from pathlib import Path
import json
import re
import warnings
import netCDF4
import numpy as np
from scipy.io import netcdf_file

from common import terrain_stats, low_sun_fraction, pressure_from_elevation
from criteria import CRITERIA

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "app" / "data"
OUT.mkdir(parents=True, exist_ok=True)

RES = 0.5                      # marimea celulei (grade)
NLAT, NLON = int(180 / RES), int(360 / RES)
PIX = 1 / 30                   # ETOPO esantionat la 2′
PER = int(round(RES / PIX))    # 15 pixeli ETOPO pe latura unei celule
M_PER_DEG = 111_195.0          # metri per grad de latitudine (sfera de 6371 km)


def load_etopo() -> tuple[np.ndarray, np.ndarray]:
    """Lipeste benzile ETOPO intr-o singura matrice (lat crescator, lon -180..180)."""
    lats, rows = [], []
    for f in sorted(RAW.glob("etopo_*.nc"), key=lambda p: float(p.stem.split("_")[1])):
        with netcdf_file(f, "r", mmap=False) as nc:
            lat = nc.variables["latitude"][:].copy()
            alt = nc.variables["altitude"][:].astype(np.float32)
        lats.append(lat)
        rows.append(alt)
    lat = np.concatenate(lats)
    alt = np.concatenate(rows, axis=0)
    lat, keep = np.unique(np.round(lat, 6), return_index=True)
    alt = alt[keep]
    if alt.shape[1] % 2 == 1:      # coloana de la 180° dubleaza coloana de la -180°
        alt = alt[:, :-1]
    print("ETOPO", alt.shape, "lat", lat[0], "->", lat[-1])
    return lat, alt


def _find_var(g, name):
    if name in g.variables:
        return g.variables[name]
    for sub in g.groups.values():
        v = _find_var(sub, name)
        if v is not None:
            return v
    return None


def _to_cells(a: np.ndarray) -> np.ndarray:
    """Agrega o matrice globala (rand 0 = nord) la celule de 0,5° (rand 0 = sud), cu NaN unde lipsesc date."""
    k = a.shape[0] // NLAT
    a = a.reshape(NLAT, k, NLON, k)
    valid = np.isfinite(a).sum(axis=(1, 3))
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        m = np.nanmean(a, axis=(1, 3))
    m[valid == 0] = np.nan
    return m[::-1]


def load_modis() -> tuple[np.ndarray, np.ndarray, int]:
    """MODIS MOD11C3: temperatura medie anuala a suprafetei si maxima lunara (zi), in °C.

    Climatologie 2020-2024: media pe fiecare luna calendaristica, apoi
      t_mean = media celor 12 luni ((zi + noapte) / 2)
      t_max  = cea mai calda luna (temperatura de zi)
    """
    files = sorted((RAW / "nasa").glob("modis_lst_*.nc4"))
    day = {m: [] for m in range(12)}
    night = {m: [] for m in range(12)}
    for f in files:
        doy = int(re.search(r"\.A\d{4}(\d{3})\.", f.name).group(1))
        month = (datetime(2001, 1, 1) + timedelta(days=doy - 1)).month - 1
        with netCDF4.Dataset(f) as nc:
            for name, store in (("LST_Day_CMG", day), ("LST_Night_CMG", night)):
                v = _find_var(nc, name)
                v.set_auto_maskandscale(True)
                store[month].append(np.ma.filled(v[:].astype(np.float64), np.nan) - 273.15)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        dclim = np.stack([np.nanmean(day[m], axis=0) for m in range(12)])
        nclim = np.stack([np.nanmean(night[m], axis=0) for m in range(12)])
        t_mean = np.nanmean((dclim + nclim) / 2, axis=0)
        t_max = np.nanmax(dclim, axis=0)
    print(f"MODIS: {len(files)} luni, grid {t_mean.shape}")
    return _to_cells(t_mean), _to_cells(t_max), len(files)


def load_gpm() -> tuple[np.ndarray, int]:
    """GPM IMERG 3IMERGM: precipitatii anuale (mm), media 2020-2024."""
    files = sorted((RAW / "nasa").glob("gpm_precip_*.nc4"))
    acc = []
    for f in files:
        with netCDF4.Dataset(f) as nc:
            v = _find_var(nc, "precipitation")
            v.set_auto_maskandscale(True)
            a = np.ma.filled(v[:].astype(np.float64), np.nan)[0]       # (lon, lat), mm/ora
            a[a < 0] = np.nan
            acc.append(a.T)                                              # (lat sud->nord, lon)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        annual = np.nanmean(acc, axis=0) * 8766.0                       # mm/ora -> mm/an
    print(f"GPM: {len(files)} luni, grid {annual.shape}")
    if annual.shape != (NLAT, NLON):
        annual = _to_cells(annual[::-1])
    return annual, len(files)


def main() -> None:
    lat, alt = load_etopo()
    tmean, tmax, n_modis = load_modis()
    precip, n_gpm = load_gpm()

    ids = {c["id"]: [] for c in CRITERIA}
    cells = []
    for i in range(NLAT):
        lat_c = -90 + (i + 0.5) * RES
        lowsun = low_sun_fraction(round(lat_c, 2), 23.44)
        r0 = i * PER
        dy = PIX * M_PER_DEG
        dx = max(dy * np.cos(np.radians(lat_c)), 50.0)
        for j in range(NLON):
            c0 = j * PER
            z = alt[r0:r0 + PER, c0:c0 + PER]
            climate = np.isfinite(tmean[i, j])             # MODIS LST exista doar pe uscat
            if not climate and z.mean() <= 0:
                continue                                   # ocean
            # In celulele de coasta, fundul marii nu e teren accesibil: suprafata apei = nivelul 0.
            # (Efect secundar: depresiunile de sub nivelul marii, ex. Marea Moarta, sunt aplatizate la 0.)
            t = terrain_stats(np.maximum(z, 0), dx, dy)
            cells.append(i * NLON + j)
            ids["slope_mean"].append(round(t["slope_mean"], 2))
            ids["slope_p90"].append(round(t["slope_p90"], 2))
            ids["relief"].append(round(t["relief"]))
            ids["roughness"].append(round(t["roughness"], 1))
            ids["pressure"].append(round(pressure_from_elevation(t["elev_mean"])))
            ids["low_sun"].append(round(lowsun, 1))
            if climate:
                ids["t_mean"].append(round(float(tmean[i, j]), 1))
                ids["t_max"].append(round(float(tmax[i, j]), 1))
                ids["ice"].append(1 if tmean[i, j] < -5 else 0)
            else:
                for k in ("t_mean", "t_max", "ice"):
                    ids[k].append(None)
            p = precip[i, j]
            ids["precip"].append(round(float(p)) if np.isfinite(p) else None)
        if i % 30 == 0:
            print(f"lat {lat_c:+.1f}  celule uscat: {len(cells)}")

    # Distributia fiecarui criteriu pe uscat: folosita in interfata pentru scorul pe percentile
    quant = {}
    stats = {}
    for k, v in ids.items():
        arr = np.array([x for x in v if x is not None], dtype=np.float64)
        quant[k] = [round(float(q), 3) for q in np.percentile(arr, np.linspace(0, 100, 201))]
        stats[k] = {"min": float(arr.min()), "max": float(arr.max()), "n": int(arr.size)}

    data = {
        "res": RES, "nlat": NLAT, "nlon": NLON,
        "cells": cells, "values": ids, "quantiles": quant, "stats": stats,
    }
    (OUT / "earth_grid.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf8")
    print("scris", OUT / "earth_grid.json", len(cells), "celule")
    for k, s in stats.items():
        print(f"  {k:10s} min {s['min']:9.1f}  max {s['max']:9.1f}  n {s['n']}")


if __name__ == "__main__":
    main()
