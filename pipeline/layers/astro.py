"""Polar day and polar night: pure geometry from latitude and axial tilt, no data files.

Same simple model as common.low_sun_fraction: the Sun's declination swings sinusoidally between
+/- the axial tilt over one year. A day counts as polar day when the Sun's lowest elevation stays
above -0.83° (refraction and the solar disc), and as polar night when its highest stays below it.
Values are a share of the year, so bodies with different year lengths can be compared.
"""
import numpy as np
from . import NLAT, NLON, cell_lats

NAME = "astro"
TILT = {"earth": 23.44, "moon": 1.54, "mars": 25.19}
SRC = "Astronomical calculation by latitude (axial tilt: Earth 23.44°, Moon 1.54°, Mars 25.19°)"

CRITERIA = [
    {
        "id": "polar_day", "group": "Light and shadow", "name": "Polar day", "unit": "%", "decimals": 0, "weight": 0.5,
        "description": "Share of the year when the Sun never sets.",
        "earth_source": SRC, "target_source": {"moon": SRC, "mars": SRC},
        "why": "Weeks of continuous low sunlight are what solar power and crew sleep schedules face near the poles.",
        "formula": "days with |φ| + δ·sign(φ) − 90° > −0.83°, as a share of the year",
        "limit": "Ignores local terrain. On the Moon the cycle runs over about 346 days, not a calendar year.",
    },
    {
        "id": "polar_night", "group": "Light and shadow", "name": "Polar night", "unit": "%", "decimals": 0, "weight": 0.5,
        "description": "Share of the year when the Sun never rises.",
        "earth_source": SRC, "target_source": {"moon": SRC, "mars": SRC},
        "why": "How long hardware has to survive without direct sunlight.",
        "formula": "days with 90° − |φ| + δ·sign(φ) < −0.83°, as a share of the year",
        "limit": "Ignores local terrain: a ridge can stay lit, a crater floor can stay dark.",
    },
]


def shares(lat_deg: float, tilt_deg: float) -> tuple[float, float]:
    decl = tilt_deg * np.sin(np.linspace(0, 2 * np.pi, 365, endpoint=False))
    ds = decl * (1 if lat_deg >= 0 else -1)
    day = (abs(lat_deg) + ds - 90) > -0.83
    night = (90 - abs(lat_deg) + ds) < -0.83
    return 100.0 * day.mean(), 100.0 * night.mean()


def fetch() -> None:
    pass


def earth() -> dict:
    d = np.zeros((NLAT, NLON))
    n = np.zeros((NLAT, NLON))
    for i, lat in enumerate(cell_lats()):
        d[i], n[i] = shares(float(lat), TILT["earth"])
    return {"polar_day": d, "polar_night": n}


def target(t: dict) -> dict:
    d, n = shares(t["lat"], TILT[t["body"]])
    return {"polar_day": d, "polar_night": n}
