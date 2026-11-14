"""Soil with little microbial life: a 0-1 proxy built from climate and soil, not a measurement of microbes.

    LB = 0.45·W + 0.30·C + 0.15·T + 0.10·V
    W  = clip((log10 0.2 − log10 AI) / (log10 0.2 − log10 0.002), 0, 1)   AI = P / PET (annual)
    C  = clip((log10 20 − log10 SOC) / (log10 20 − log10 1), 0, 1)       SOC in g/kg, 0-5 cm
    T  = clip((5 − Tmean) / 30, 0, 1)                                    Tmean in °C
    V  = 1 where NDVI < 0.1 (no plant growth), else 0

Sources
- Aridity: TerraClimate 1991-2020 monthly climatology (Abatzoglou et al. 2018, University of Idaho
  Climatology Lab), ppt and pet summed over 12 months. Public domain (CC0). Read through OPeNDAP with a
  stride of 12 native cells: one 1/24° sample near the centre of each 0.5° cell (no averaging, demo-sized).
- SOC: ISRIC SoilGrids 2.0, soc 0-5 cm mean (CC BY 4.0), requested from the ISRIC WCS re-projected to
  EPSG:4326 (the native grid is Interrupted Goode Homolosine), then averaged into 0.5° cells.
  SoilGrids stores soc in dg/kg; g/kg = value / 10. A value of 0 is the WCS no-data fill.
- Tmean: MERRA-2 t2m from raw/layers/merra/merra.npz if present, else the MODIS land-surface mean
  temperature already in app/data/earth_grid.json (t_mean).
- V: MODIS NDVI from raw/layers/modis/modis.npz if present; otherwise V is dropped and the other weights
  are renormalised.

AI and SOC are cached in raw/layers/soil/soil.npz by fetch(); earth() combines them with whatever
temperature / NDVI source exists at that moment, so later layers are picked up automatically.
"""
import json
import warnings
import numpy as np
from . import RAW, ROOT, NLAT, NLON, RES, to_grid, cell_lats

NAME = "soil"
DIR = RAW / "soil"
NPZ = DIR / "soil.npz"
SOC_TIF = DIR / "soc_0-5cm_mean_wcs4326.tif"
TC_URL = "http://thredds.northwestknowledge.net:8080/thredds/dodsC/TERRACLIMATE_ALL/climatology/TerraClimate_19912020_{v}.nc"
WCS_URL = ("https://maps.isric.org/mapserv?map=/map/soc.map&SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage"
           "&COVERAGEID=soc_0-5cm_mean&FORMAT=image/tiff&SUBSET=long(-180,180)&SUBSET=lat(-90,90)"
           "&SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326"
           "&OUTPUTCRS=http://www.opengis.net/def/crs/EPSG/0/4326&SCALESIZE=long(7200),lat(3600)")
STRIDE = 12          # 1/24° native -> one sample per 0.5° cell (about 1 MB per month and variable)
WEIGHTS = {"W": 0.45, "C": 0.30, "T": 0.15, "V": 0.10}
ANTARCTICA_LAT = -60.0

SRC = ("TerraClimate 1991-2020 climatology, ppt and pet (University of Idaho, CC0); ISRIC SoilGrids 2.0 soc 0-5 cm "
       "(CC BY 4.0); mean annual temperature (MERRA-2 t2m, or MODIS land-surface temperature); MODIS NDVI when available")
TSRC = "Not measured: every target is treated as sterile (no indigenous biology is known), so higher is always closer"

CRITERIA = [
    {
        "id": "low_biomass", "group": "Life", "name": "Soil with little microbial life", "unit": "", "decimals": 2,
        "weight": 1.0, "mode": "higher", "lo": 0.5, "hi": 0.9, "bodies": ["moon", "mars"],
        "description": ("Estimate from 0 to 1 of how close to lifeless the soil is, built from dryness, soil organic carbon, "
                        "cold and the absence of plants. It is an estimate from climate and soil maps, not a measurement "
                        "of microbes."),
        "earth_source": SRC, "target_source": {"moon": TSRC, "mars": TSRC},
        "why": "Life-detection instruments and contamination-control procedures need a low biological background to test against.",
        "formula": ("LB = 0.45·W + 0.30·C + 0.15·T + 0.10·V; W = clip((log 0.2 − log AI)/(log 0.2 − log 0.002)), "
                    "AI = annual P / PET; C = clip((log 20 − log SOC)/(log 20 − log 1)), SOC in g/kg at 0-5 cm; "
                    "T = clip((5 − Tmean)/30); V = 1 where NDVI < 0.1. The weights are this project's own proposal, "
                    "not a published method."),
        "limit": ("No natural surface on Earth is sterile: the poorest soil measured, in University Valley (Antarctica), "
                  "still holds on the order of a thousand cells per gram. Global soil and aridity maps rest on very few "
                  "field samples in hyperarid and polar regions. One 0.5° cell hides microbes under rocks, inside rocks "
                  "and in fog oases. SoilGrids is poorly constrained in hyperarid deserts and likely overestimates "
                  "their organic carbon (it gives about 10-15 g/kg around Yungay in the Atacama). No global soil map "
                  "covers Antarctica, and TerraClimate PET is zero there, so the aridity index is undefined: Antarctic "
                  "cells use only the terms that exist (in practice cold, plus plants when NDVI is available), with "
                  "the weights renormalised, so they mostly score near 1 and cannot tell ice-free valleys from the "
                  "ice sheet. Elsewhere cells without soil or aridity data are left empty. Aridity uses one "
                  "TerraClimate sample per 0.5° cell, not a cell average. "
                  "When no NDVI layer is available the plant term is dropped and the weights renormalised. Confirming "
                  "a site needs field sampling. For extremophile studies the direction is reversed: you want the "
                  "places where life does hold on."),
        "licence": "TerraClimate: CC0 (public domain). SoilGrids 2.0: CC BY 4.0, © ISRIC - World Soil Information.",
    },
]


# ---------------------------------------------------------------- fetch

def _terraclimate_annual(var: str) -> np.ndarray:
    """Annual total (mm) on a 1/4° grid, row 0 = north, column 0 = 180°W; NaN over sea."""
    import netCDF4
    with netCDF4.Dataset(TC_URL.format(v=var)) as d:
        v = d[var]
        v.set_auto_maskandscale(True)
        tot = None
        for m in range(12):
            a = np.ma.filled(v[m, STRIDE // 2::STRIDE, STRIDE // 2::STRIDE].astype(np.float64), np.nan)
            tot = a if tot is None else tot + a
    return tot


def _soc_grid() -> np.ndarray:
    """SoilGrids soc 0-5 cm in g/kg on the app grid (mean of all WCS pixels whose centre falls in a cell)."""
    import tifffile
    with tifffile.TiffFile(SOC_TIF) as t:
        p = t.pages[0]
        a = p.asarray().astype(np.float64)
        sx, sy, _ = p.tags["ModelPixelScaleTag"].value
        _, _, _, x0, y0, _ = p.tags["ModelTiepointTag"].value
    a[a <= 0] = np.nan                              # 0 = WCS fill, -32768 = no data
    a /= 10.0                                       # dg/kg -> g/kg
    ny, nx = a.shape
    lat = y0 - (np.arange(ny) + 0.5) * sy
    lon = x0 + (np.arange(nx) + 0.5) * sx
    r = np.clip(((lat + 90) / RES).astype(int), 0, NLAT - 1)
    c = np.clip(((lon + 180) / RES).astype(int), 0, NLON - 1)
    idx = (r[:, None] * NLON + c[None, :]).ravel()
    v = a.ravel()
    ok = np.isfinite(v)
    s = np.bincount(idx[ok], weights=v[ok], minlength=NLAT * NLON)
    n = np.bincount(idx[ok], minlength=NLAT * NLON)
    out = np.where(n > 0, s / np.maximum(n, 1), np.nan)
    return out.reshape(NLAT, NLON)


def fetch() -> None:
    import requests
    DIR.mkdir(parents=True, exist_ok=True)
    if not SOC_TIF.exists():
        r = requests.get(WCS_URL, timeout=900)
        r.raise_for_status()
        if "tiff" not in r.headers.get("content-type", ""):
            raise RuntimeError(f"SoilGrids WCS returned {r.headers.get('content-type')}: {r.text[:300]}")
        tmp = SOC_TIF.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.replace(SOC_TIF)
    if NPZ.exists():
        return
    ppt = _terraclimate_annual("ppt")
    pet = _terraclimate_annual("pet")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        P = to_grid(ppt, south_first=False)
        PET = to_grid(pet, south_first=False)
    np.savez_compressed(NPZ, P=P, PET=PET, SOC=_soc_grid())


# ---------------------------------------------------------------- earth

def _tmean():
    f = RAW / "merra" / "merra.npz"
    if f.exists():
        with np.load(f) as z:
            if "t2m" in z.files:
                return np.asarray(z["t2m"], dtype=np.float64), "MERRA-2 t2m"
    g = json.loads((ROOT / "app" / "data" / "earth_grid.json").read_text(encoding="utf8"))
    t = np.full(NLAT * NLON, np.nan)
    t[np.asarray(g["cells"])] = [np.nan if x is None else x for x in g["values"]["t_mean"]]
    return t.reshape(NLAT, NLON), "MODIS LST t_mean (earth_grid.json)"


def _ndvi():
    f = RAW / "modis" / "modis.npz"
    if f.exists():
        with np.load(f) as z:
            if "ndvi" in z.files:
                return np.asarray(z["ndvi"], dtype=np.float64)
    return None


def components() -> dict:
    """All terms on the app grid, plus which sources were used."""
    if not NPZ.exists():
        raise FileNotFoundError(f"{NPZ} missing: run fetch()")
    with np.load(NPZ) as z:
        P, PET, SOC = z["P"], z["PET"], z["SOC"]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        # PET = 0 (frozen all year, mostly Antarctica): AI is undefined, so W is left missing there
        AI = np.where(PET > 0, P / PET, np.nan)
        W = np.clip((np.log10(0.2) - np.log10(AI)) / (np.log10(0.2) - np.log10(0.002)), 0, 1)
        C = np.clip((np.log10(20) - np.log10(SOC)) / (np.log10(20) - np.log10(1)), 0, 1)
    tm, tsrc = _tmean()
    T = np.clip((5 - tm) / 30, 0, 1)
    nd = _ndvi()
    V = None if nd is None else np.where(np.isfinite(nd), (nd < 0.1).astype(float), np.nan)

    terms = {"W": W, "C": C, "T": T}
    if V is not None:
        terms["V"] = V
    ant = (cell_lats() < ANTARCTICA_LAT)[:, None] & np.ones((1, NLON), bool)

    def combine(keys):
        w = sum(WEIGHTS[k] for k in keys)
        return sum(WEIGHTS[k] * terms[k] for k in keys) / w

    LB = combine(list(terms))                                    # NaN wherever any term is missing
    # Antarctica: no soil map, and TerraClimate PET is 0 almost everywhere, so use the terms that exist per cell
    num = sum(np.where(np.isfinite(terms[k]), WEIGHTS[k] * terms[k], 0.0) for k in terms if k != "C")
    den = sum(np.where(np.isfinite(terms[k]), WEIGHTS[k], 0.0) for k in terms if k != "C")
    with np.errstate(invalid="ignore", divide="ignore"):
        LB_ant = np.where(den > 0, num / den, np.nan)
    LB = np.where(ant & ~np.isfinite(SOC), LB_ant, LB)
    return {"LB": LB, "W": W, "C": C, "T": T, "V": V, "AI": AI, "SOC": SOC, "Tmean": tm,
            "tmean_source": tsrc, "ndvi_used": V is not None}


def earth() -> dict:
    c = components()
    with np.load(NPZ) as z:
        base = {k: z[k] for k in ("P", "PET", "SOC")}
    try:                                                         # cache the final array with its components
        np.savez_compressed(NPZ, **base,
                            LB=c["LB"], W=c["W"], C=c["C"], T=c["T"], AI=c["AI"],
                            V=c["V"] if c["V"] is not None else np.full((NLAT, NLON), np.nan))
    except OSError:
        pass
    return {"low_biomass": c["LB"]}


def target(t: dict) -> dict:
    return {"low_biomass": 1.0}
