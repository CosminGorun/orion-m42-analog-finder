"""NASA MODIS layers: vegetation (NDVI) and snow-free surface albedo.

Reduced demo amount of data:
  - MOD13C2 v061 (Terra, monthly, 0.05° CMG): NDVI and pixel reliability for the 20 months
    January 2022 - August 2023, read through OPeNDAP with a stride of 2 (0.1°).
  - MCD43C3 v061 (Terra+Aqua, daily 16-day BRDF/albedo, 0.05° CMG): white-sky shortwave albedo and
    Percent_Snow. The collection is not served by OPeNDAP, so whole HDF4 granules (~190 MB each) are
    downloaded, reduced to the two variables, and deleted. Four granules: 15 Jan, Apr, Jul, Oct 2023.

Authentication: NASA Earthdata token from D:\\alba\\.earthdata_token or EARTHDATA_TOKEN (never printed).
"""
from pathlib import Path
import datetime as dt
import json
import os
import re
import time
import numpy as np
from . import NLAT, NLON, RAW, ROOT

NAME = "modis"
DIR = RAW / NAME
OUT = DIR / "modis.npz"
TARGET_VALUES = Path(__file__).resolve().parent / "target_values.json"

CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
OPENDAP = "https://opendap.earthdata.nasa.gov/collections/{cid}/granules/{gid}"
NDVI_CID = "C2565788914-LPCLOUD"      # MOD13C2 v061
ALB_CID = "C2532068039-LPCLOUD"       # MCD43C3 v061
NDVI_GROUP = "/MOD_Grid_monthly_CMG_VI/Data_Fields/"
NDVI_VAR = "CMG_0_05_Deg_Monthly_NDVI"                  # int16, value / 10000, fill -3000
REL_VAR = "CMG_0_05_Deg_Monthly_pixel_reliability"     # int8: 0 good, 1 marginal, 2 snow/ice, 3 cloudy, 4 estimated, -1 fill
NDVI_TEMPORAL = "2022-01-01T00:00:00Z,2023-08-31T23:59:59Z"   # 20 monthly granules (demo amount)
STRIDE = 2
ALB_DATES = [(2023, 1), (2023, 4), (2023, 7), (2023, 10)]       # (year, month), day 15
MIN_VALID = 0.30

LICENCE = "NASA LP DAAC, open data, no restrictions; citation requested"
NDVI_SRC = ("NASA MODIS MOD13C2 v061 (Terra, monthly 0.05° NDVI), January 2022 - August 2023 (20 months), "
            "sampled at 0.1°; per-pixel maximum, snow/ice and cloudy months removed")
ALB_SRC = ("NASA MODIS MCD43C3 v061 (Terra+Aqua BRDF/albedo, 0.05°), white-sky shortwave albedo, "
           "mean of four 16-day retrievals dated 15 January, April, July and October 2023, snow-covered pixels removed")

CRITERIA = [
    {
        "id": "ndvi", "group": "Life", "name": "Vegetation (NDVI)", "unit": "", "decimals": 2, "weight": 1.0,
        "mode": "lower", "lo": 0.1, "hi": 0.2, "bodies": ["moon", "mars"],
        "description": ("How green the ground is seen from orbit at the greenest time of year. Plants absorb red light "
                        "and reflect near-infrared strongly, so the normalised difference of the two is high over "
                        "vegetation and near zero over bare rock and sand. The MODIS sensor is passive: it measures "
                        "reflected sunlight and emits nothing. Below about 0.1 the ground is bare; 0.1-0.2 is sparse "
                        "vegetation. Uses the monthly maps of January 2022 - August 2023 (20 months)."),
        "earth_source": NDVI_SRC,
        "target_source": {"moon": "No vegetation: set to 0", "mars": "No vegetation: set to 0"},
        "why": ("Vegetation scatters radar, adds organic matter that confuses instruments, and roots change how far "
                "wheels and feet sink, so a test site should be as bare as the target."),
        "formula": ("NDVI = (NIR − Red) / (NIR + Red); per pixel the maximum over the 20 monthly maps Jan 2022 - "
                    "Aug 2023; block mean to 0.5°, NaN if under 30% of pixels are valid"),
        "limit": ("Only 20 months (all of 2022, January-August 2023), fewer than three full years: a single year's "
                  "growing season is covered once, so vegetation after an unusually dry 2022 or in late 2023 may be "
                  "missed. Snow, ice and water also give low NDVI, so months flagged snow/ice or cloud and negative "
                  "values are removed (permanent ice sheets therefore have no value). NDVI sees plants, not microbes; "
                  "lichens and biological soil crusts can raise it slightly."),
        "licence": LICENCE,
    },
    {
        "id": "albedo", "group": "Surface and minerals", "name": "Surface albedo", "unit": "", "decimals": 2,
        "weight": 0.5, "mode": "match", "bodies": ["moon", "mars"],
        "description": ("Share of incoming sunlight (0.3-5 µm) the ground reflects under diffuse light (white-sky "
                        "albedo), from snow-free observations."),
        "earth_source": ALB_SRC,
        "target_source": {"moon": "Published albedo for the site (see target notes)",
                          "mars": "Published albedo for the site (see target notes)"},
        "why": ("Albedo controls how hot the surface gets in sunlight and how cameras must be exposed; the Moon is "
                "dark, so a bright test site behaves differently in both."),
        "formula": "mean of Albedo_WSA_shortwave × 0.001 over the sampled dates, snow pixels removed; block mean to 0.5°",
        "limit": ("Broadband albedo says how bright the ground is, not what it is made of. Snow-free mean over four "
                  "dates in 2023 only (15 Jan, Apr, Jul, Oct); permanently snow-covered ground has no value."),
        "licence": LICENCE,
    },
]


# ---------------------------------------------------------------- download

def _session():
    import requests
    t = os.environ.get("EARTHDATA_TOKEN")
    f = ROOT / ".earthdata_token"
    if not t and f.exists():
        t = f.read_text(encoding="utf8").strip()
    if not t:
        raise RuntimeError("NASA Earthdata token missing: save it in D:\\alba\\.earthdata_token")
    s = requests.Session()
    s.headers["Authorization"] = f"Bearer {t}"
    return s


def _get(s, url, stream=False, **kw):
    import requests
    for attempt in range(5):
        try:
            r = s.get(url, timeout=600, stream=stream, **kw)
            if r.status_code in (401, 403):
                raise RuntimeError(f"access refused ({r.status_code}) for {url.split('?')[0]}")
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            print(f"    retry {attempt + 1}: {type(e).__name__}")
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed: {url.split('?')[0]}")


def _granules(cid, temporal):
    import requests
    r = requests.get(CMR, params={"collection_concept_id": cid, "temporal": temporal, "page_size": 200}, timeout=60)
    r.raise_for_status()
    return r.json()["feed"]["entry"]


def _fetch_ndvi(s):
    import requests
    d = DIR / "ndvi"
    d.mkdir(parents=True, exist_ok=True)
    entries = _granules(NDVI_CID, NDVI_TEMPORAL)
    ce = ";".join(f"{NDVI_GROUP}{v}[0:{STRIDE}:3599][0:{STRIDE}:7199]" for v in (NDVI_VAR, REL_VAR))
    for e in entries:
        title = e["title"]
        dest = d / f"{title}.nc4"
        if dest.exists() and dest.stat().st_size > 0:
            continue
        base = OPENDAP.format(cid=NDVI_CID, gid=requests.utils.quote(title, safe=""))
        r = _get(s, base + ".dap.nc4", params={"dap4.ce": ce})
        tmp = dest.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.replace(dest)
        print(f"   {title}  {len(r.content) / 1e6:.1f} MB")


def _fetch_albedo(s):
    from pyhdf.SD import SD, SDC
    d = DIR / "albedo"
    d.mkdir(parents=True, exist_ok=True)
    for y, m in ALB_DATES:
        day = dt.date(y, m, 15)
        tag = f"A{y}{day.timetuple().tm_yday:03d}"
        dest = d / f"MCD43C3.{tag}.npz"
        if dest.exists() and dest.stat().st_size > 0:
            continue
        entries = [e for e in _granules(ALB_CID, f"{day}T00:00:00Z,{day}T23:59:59Z") if f".{tag}." in e["title"]]
        if not entries:
            print(f"   MCD43C3 {tag}: no granule")
            continue
        e = entries[0]
        url = next(l["href"] for l in e["links"] if l.get("href", "").startswith("https") and l["href"].endswith(".hdf"))
        hdf = d / f"{e['title']}.hdf"
        if not (hdf.exists() and hdf.stat().st_size > 0):
            r = _get(s, url, stream=True)
            tmp = hdf.with_suffix(".part")
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
            tmp.replace(hdf)
        sd = SD(str(hdf), SDC.READ)
        out = {}
        for v in ("Albedo_WSA_shortwave", "Percent_Snow"):
            ds = sd.select(v)
            out[v] = ds.get()
            out[v + "_attrs"] = json.dumps({k: (np.asarray(a).tolist() if not isinstance(a, str) else a)
                                            for k, a in ds.attributes().items()})
            ds.endaccess()
        sd.end()
        np.savez_compressed(dest, **out)
        print(f"   {e['title']}  {hdf.stat().st_size / 1e6:.0f} MB -> {dest.stat().st_size / 1e6:.1f} MB extract")
        hdf.unlink()


# ---------------------------------------------------------------- aggregation

def _to_app_grid(a):
    """(lat, lon) north-first global array, finer than 0.5° -> (360, 720) south-first block mean; NaN under 30% valid."""
    a = np.asarray(a, dtype=np.float64)[::-1]
    k, m = a.shape[0] // NLAT, a.shape[1] // NLON
    b = a.reshape(NLAT, k, NLON, m)
    n = np.isfinite(b).sum(axis=(1, 3))
    s = np.nansum(b, axis=(1, 3))
    return np.where(n >= MIN_VALID * k * m, s / np.maximum(n, 1), np.nan)


def _ndvi_grid():
    import h5py
    files = sorted((DIR / "ndvi").glob("*.nc4"))
    if not files:
        return np.full((NLAT, NLON), np.nan)
    mx = None
    for f in files:                                    # per-pixel maximum over every month on disk
        with h5py.File(f, "r") as h:
            raw = h[NDVI_GROUP + NDVI_VAR][:]
            rel = h[NDVI_GROUP + REL_VAR][:]
        v = raw.astype(np.float32) / 10000.0           # scale_factor 10000 (HDF4 convention: divide)
        bad = (raw == -3000) | (rel < 0) | (rel == 2) | (rel == 3) | (v < 0)
        v[bad] = np.nan
        mx = v if mx is None else np.fmax(mx, v)
    return _to_app_grid(mx)


def _albedo_grid():
    files = [DIR / "albedo" / f"MCD43C3.A{y}{dt.date(y, m, 15).timetuple().tm_yday:03d}.npz" for y, m in ALB_DATES]
    if not all(f.exists() for f in files):            # the criterion text promises all four seasons
        return np.full((NLAT, NLON), np.nan)
    s = n = None
    for f in files:
        z = np.load(f)
        at = json.loads(str(z["Albedo_WSA_shortwave_attrs"]))
        raw = z["Albedo_WSA_shortwave"]
        fill = at.get("_FillValue", 32767)
        fill = fill[0] if isinstance(fill, list) else fill
        sc = at.get("scale_factor", 0.001)
        sc = sc[0] if isinstance(sc, list) else sc
        v = raw.astype(np.float64) * sc
        ok = (raw != fill) & (v >= 0) & (v <= 1)
        snow = z["Percent_Snow"].astype(np.int32)
        ok &= snow == 0                                   # keep only pixels known to be snow-free (fill excluded)
        v = np.where(ok, v, 0.0)
        s = v if s is None else s + v
        n = ok.astype(np.int32) if n is None else n + ok
    mean = np.where(n > 0, s / np.maximum(n, 1), np.nan)
    return _to_app_grid(mean)


def _build():
    np.savez_compressed(OUT, ndvi=_ndvi_grid(), albedo=_albedo_grid())


def fetch() -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    s = _session()
    for label, fn in (("MOD13C2 NDVI", _fetch_ndvi), ("MCD43C3 albedo", _fetch_albedo)):
        print(f"[modis] {label}")
        try:
            fn(s)
        except Exception as e:                     # keep the other product if one source fails
            print(f"   failed: {type(e).__name__}: {e}")
    inputs = list((DIR / "ndvi").glob("*.nc4")) + list((DIR / "albedo").glob("*.npz"))
    if not OUT.exists() or any(f.stat().st_mtime > OUT.stat().st_mtime for f in inputs):
        _build()


def earth() -> dict:
    if not OUT.exists():
        raise FileNotFoundError(f"{OUT} missing: run fetch() (python pipeline/build_layers.py --fetch)")
    z = np.load(OUT)
    out = {}
    for c in CRITERIA:
        out[c["id"]] = z[c["id"]] if c["id"] in z.files else np.full((NLAT, NLON), np.nan)
    return out


def target(t: dict) -> dict:
    alb = None
    if TARGET_VALUES.exists():
        try:
            v = json.loads(TARGET_VALUES.read_text(encoding="utf8")).get(t.get("id"), {}).get("albedo")
            alb = float(v) if v is not None else None
        except (ValueError, AttributeError, TypeError):
            alb = None
    return {"ndvi": 0.0, "albedo": alb}
