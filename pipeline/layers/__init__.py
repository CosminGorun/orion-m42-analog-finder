"""One module per data layer. See pipeline/build_layers.py for the contract."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
RAW = ROOT / "raw" / "layers"
NLAT, NLON, RES = 360, 720, 0.5


def cell_lats():
    """Centre latitude of each grid row (row 0 = 89.75°S)."""
    import numpy as np
    return -90 + (np.arange(NLAT) + 0.5) * RES


def to_grid(a, south_first: bool, lon0: float = -180.0):
    """Regrid a regular global lat/lon array to the app grid (360 x 720) by block mean or nearest neighbour.

    a           : 2D array (lat, lon) covering the globe
    south_first : True if row 0 is the southernmost row
    lon0        : longitude of the western edge of column 0 (-180 or 0)
    """
    import numpy as np
    a = np.asarray(a, dtype=np.float64)
    if not south_first:
        a = a[::-1]
    if lon0 == 0.0:
        a = np.roll(a, a.shape[1] // 2, axis=1)
    ny, nx = a.shape
    if ny % NLAT == 0 and nx % NLON == 0:                      # finer grid: block mean, ignoring NaN
        k, m = ny // NLAT, nx // NLON
        b = a.reshape(NLAT, k, NLON, m)
        n = np.isfinite(b).sum(axis=(1, 3))
        s = np.nansum(b, axis=(1, 3))
        return np.where(n > 0, s / np.maximum(n, 1), np.nan)
    lat = -90 + (np.arange(NLAT) + 0.5) * RES                  # otherwise nearest neighbour
    lon = -180 + (np.arange(NLON) + 0.5) * RES
    r = np.clip(np.round((lat + 90) / 180 * ny - 0.5).astype(int), 0, ny - 1)
    c = np.clip(np.round((lon + 180) / 360 * nx - 0.5).astype(int), 0, nx - 1)
    return a[np.ix_(r, c)]
