"""Sample the Montabone et al. column dust optical depth climatology at Mars targets.

Not a layer (underscore prefix). Run manually:
    python pipeline/layers/_montabone_sample.py

Input: kriged daily dust scenarios (dustscenario_MY??_v*.nc, 3 deg x 3 deg grid) from
http://www-mars.lmd.jussieu.fr/mars/dust_climatology/ (CC BY-SA 3.0), stored in
raw/layers/montabone/. Variable used: `cdod610` = IR absorption (9.3 um) column dust
optical depth normalised to 610 Pa (dims Time, latitude, longitude).

Conversion: the dataset page ("Important notes") states that equivalent visible column
optical depth = 9.3 um absorption CDOD x 2.6 (Montabone et al. 2015, Icarus 251, Sect. 2.3.4).

For each target the grid cell containing it is sampled:
  dust_tau       = median over all sols of the available non-global-storm years
  dust_tau_storm = maximum over all sols of MY25, MY28, MY34 (global dust storm years)
Only the years present on disk are used; they are listed in the output.
"""
import json
import re
import sys
from pathlib import Path

import netCDF4
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "raw" / "layers" / "montabone"
STORM_YEARS = {25, 28, 34}
VIS_FACTOR = 2.6


def targets() -> list[dict]:
    out = []
    for p in (ROOT / "pipeline" / "targets.json", ROOT / "pipeline" / "layers" / "new_targets.json"):
        if p.exists():
            out += [t for t in json.loads(p.read_text(encoding="utf-8")) if t["body"] == "mars"]
    return out


def cell(ds, lat: float, lon: float) -> tuple[int, int]:
    lats = ds["latitude"][:].astype(float)
    lons = ds["longitude"][:].astype(float)
    lon = ((lon - lons.min()) % 360) + lons.min()  # put lon in the file's convention
    i = int(np.argmin(np.abs(lats - lat)))  # nearest centre = containing cell on a regular grid
    j = int(np.argmin(np.abs(((lons - lon) + 180) % 360 - 180)))
    return i, j


def main() -> None:
    files = sorted(RAW.glob("dustscenario_MY*_v*.nc"))
    if not files:
        sys.exit(f"No dust scenario files in {RAW}")
    tg = targets()
    series = {t["id"]: {"clear": [], "storm": []} for t in tg}
    years = {"clear": [], "storm": []}
    cells = {}
    for f in files:
        my = int(re.search(r"MY(\d+)", f.name).group(1))
        kind = "storm" if my in STORM_YEARS else "clear"
        years[kind].append(my)
        with netCDF4.Dataset(f) as ds:
            var = ds["cdod610"]
            for t in tg:
                i, j = cell(ds, t["lat"], t["lon"])
                cells[t["id"]] = (float(ds["latitude"][i]), float(ds["longitude"][j]))
                v = np.ma.filled(var[:, i, j].astype(float), np.nan)
                series[t["id"]][kind].append(v)
    out = {"variable": "cdod610", "vis_factor": VIS_FACTOR, "years": years, "targets": {}}
    for t in tg:
        clear = np.concatenate(series[t["id"]]["clear"]) if series[t["id"]]["clear"] else np.array([np.nan])
        storm = np.concatenate(series[t["id"]]["storm"]) if series[t["id"]]["storm"] else np.array([np.nan])
        ir_med, ir_max = float(np.nanmedian(clear)), float(np.nanmax(storm))
        out["targets"][t["id"]] = {
            "cell_lat": cells[t["id"]][0], "cell_lon": cells[t["id"]][1],
            "ir_median_clear": round(ir_med, 4), "ir_max_storm": round(ir_max, 4),
            "dust_tau": round(ir_med * VIS_FACTOR, 2), "dust_tau_storm": round(ir_max * VIS_FACTOR, 2),
        }
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
