"""Adds the criteria defined in pipeline/layers/*.py to the app data.

Run AFTER build_earth_grid.py and build_target.py (they rewrite the JSON files without layers):

    python pipeline/build_layers.py            # merge every layer whose data is available
    python pipeline/build_layers.py --fetch    # download missing layer data first

One layer = one module in pipeline/layers/ with this contract:

    NAME = "short_name"
    CRITERIA = [ { "id", "group", "name", "unit", "decimals", "weight", "description",
                   "earth_source", "target_source": {"moon": ..., "mars": ...}, "why",
                   # optional, read by the app:
                   "mode": "match" | "lower" | "higher",   # default "match" (closeness to the target value)
                   "lo": ..., "hi": ...,                    # ramp thresholds for "lower" / "higher"
                   "bodies": ["moon", "mars"],             # where it applies (default: both)
                   "scenario": "normal" | "storm",         # only used in that Mars scenario (default: always)
                   "formula", "limit", "licence" } ]
    def fetch() -> None                      # idempotent download into raw/layers/<NAME>/
    def earth() -> dict[id, ndarray]         # (360, 720) float array per criterion; row 0 = 90°S..89.5°S,
                                             # column 0 = 180°W..179.5°W; NaN where there is no data
    def target(t: dict) -> dict[id, float | None]   # t = one entry of pipeline/targets.json

The merge is idempotent: criteria coming from layers are replaced on every run.
"""
from pathlib import Path  
import importlib
import json
import pkgutil
import sys
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "app" / "data"
sys.path.insert(0, str(Path(__file__).parent))


def modules():
    import layers
    for m in sorted(pkgutil.iter_modules(layers.__path__), key=lambda x: x.name):
        if not m.name.startswith("_"):
            yield importlib.import_module(f"layers.{m.name}")


def main() -> None:
    grid = json.loads((DATA / "earth_grid.json").read_text(encoding="utf8"))
    criteria = json.loads((DATA / "criteria.json").read_text(encoding="utf8"))
    targets = json.loads((DATA / "targets.json").read_text(encoding="utf8"))
    cells = np.array(grid["cells"])
    rows, cols = cells // grid["nlon"], cells % grid["nlon"]

    # drop what a previous run added
    old = {c["id"] for c in criteria if c.get("layer")}
    criteria = [c for c in criteria if not c.get("layer")]
    for k in old:
        for part in ("values", "quantiles", "stats"):
            grid[part].pop(k, None)
        for t in targets:
            t["values"].pop(k, None)

    done, skipped = [], []
    for mod in modules():
        try:
            if "--fetch" in sys.argv:
                mod.fetch()
            arrays = mod.earth()
        except Exception as e:                      # data not downloaded yet, or a source is down
            skipped.append(f"{mod.NAME}: {type(e).__name__}: {e}")
            continue
        for c in mod.CRITERIA:
            a = np.asarray(arrays[c["id"]], dtype=np.float64)
            if a.shape != (grid["nlat"], grid["nlon"]):
                raise ValueError(f"{c['id']}: expected {(grid['nlat'], grid['nlon'])}, got {a.shape}")
            v = a[rows, cols]
            ok = np.isfinite(v)
            if not ok.any():
                skipped.append(f"{c['id']}: no data on land")
                continue
            d = c.get("decimals", 1) + 1
            grid["values"][c["id"]] = [round(float(x), d) if f else None for x, f in zip(v, ok)]
            grid["quantiles"][c["id"]] = [round(float(q), d + 1) for q in np.percentile(v[ok], np.linspace(0, 100, 201))]
            grid["stats"][c["id"]] = {"min": float(v[ok].min()), "max": float(v[ok].max()), "n": int(ok.sum())}
            criteria.append({**c, "layer": mod.NAME})
            done.append(c["id"])
        for t in targets:
            tv = mod.target(t) or {}
            for c in mod.CRITERIA:
                if c["id"] in grid["values"]:
                    x = tv.get(c["id"])
                    t["values"][c["id"]] = None if x is None else float(x)

    (DATA / "earth_grid.json").write_text(json.dumps(grid, separators=(",", ":")), encoding="utf8")
    (DATA / "criteria.json").write_text(json.dumps(criteria, ensure_ascii=False, indent=1), encoding="utf8")
    (DATA / "targets.json").write_text(json.dumps(targets, ensure_ascii=False, indent=1), encoding="utf8")
    print("layers merged:", ", ".join(done) or "none")
    for s in skipped:
        print("  skipped ->", s)
    for k in done:
        s = grid["stats"][k]
        print(f"  {k:14s} min {s['min']:10.3f}  max {s['max']:10.3f}  n {s['n']}")


if __name__ == "__main__":
    main()
