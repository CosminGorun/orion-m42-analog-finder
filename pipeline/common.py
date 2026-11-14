"""Functii comune, folosite identic pentru Pamant si pentru zona-tinta.

Folosim exact aceleasi formule pe ambele corpuri ceresti, ca valorile sa fie comparabile.
"""
from functools import lru_cache
import numpy as np


def terrain_stats(z: np.ndarray, dx: float, dy: float) -> dict:
    """Statistici de teren pentru o fereastra de altitudini (metri).

    z  : matrice 2D de altitudini (m), fara NaN-uri
    dx : distanta dintre pixeli pe orizontala (m)
    dy : distanta dintre pixeli pe verticala (m)
    """
    gy, gx = np.gradient(z.astype(np.float64), dy, dx)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))

    # rugozitate = abaterea standard dupa eliminarea planului care aproximeaza fereastra
    ny, nx = z.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    a = np.column_stack([np.ones(z.size), xx.ravel() * dx, yy.ravel() * dy])
    coef, *_ = np.linalg.lstsq(a, z.ravel().astype(np.float64), rcond=None)
    resid = z.ravel() - a @ coef

    p5, p95 = np.percentile(z, [5, 95])
    return {
        "slope_mean": float(slope.mean()),
        "slope_p90": float(np.percentile(slope, 90)),
        "relief": float(p95 - p5),
        "roughness": float(resid.std()),
        "elev_mean": float(z.mean()),
    }


@lru_cache(maxsize=None)
def low_sun_fraction(lat_deg: float, obliquity_deg: float, threshold_deg: float = 10.0) -> float:
    """Procentul din timpul in care Soarele e deasupra orizontului si sub `threshold_deg`.

    Model simplu: declinatia Soarelui variaza sinusoidal pe parcursul anului intre
    +/- inclinarea axei. Ignora relieful (orizontul local) si refractia.
    """
    phi = np.radians(lat_deg)
    year = np.linspace(0, 2 * np.pi, 365, endpoint=False)
    decl = np.radians(obliquity_deg) * np.sin(year)              # declinatia pe parcursul anului
    hour = np.linspace(-np.pi, np.pi, 288, endpoint=False)          # unghiul orar, pas de 5 min
    d, h = np.meshgrid(decl, hour)
    sin_el = np.sin(phi) * np.sin(d) + np.cos(phi) * np.cos(d) * np.cos(h)
    el = np.degrees(np.arcsin(np.clip(sin_el, -1, 1)))
    day = el > 0
    if not day.any():
        return 0.0
    low = day & (el < threshold_deg)
    return float(100.0 * low.sum() / day.sum())


def pressure_from_elevation(z_m: float) -> float:
    """Presiunea atmosferica standard (hPa) la altitudinea data."""
    return float(1013.25 * (1 - 2.25577e-5 * max(z_m, 0.0)) ** 5.25588)
