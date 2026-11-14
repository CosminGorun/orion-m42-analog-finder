"""Descarca datele brute necesare prototipului in ../raw/.

Surse (toate deschise, fara cont):
  - LOLA LDEM_75S_240M : relieful polului sud lunar (75-90 S), 240 m/pixel [NASA PDS]
  - ETOPO1 (etopo180)  : relieful global al Pamantului, luat din 2 in 2 pixeli (~3.7 km) [NOAA ERDDAP]

Rulare:  python pipeline/fetch_data.py
"""
from pathlib import Path
import requests

RAW = Path(__file__).resolve().parent.parent / "raw"
RAW.mkdir(exist_ok=True)

LOLA_BASE = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/"
ERDDAP = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.nc"

ETOPO_STRIDE = 2          # 1 arc-min * 2 = 2 arc-min (~3.7 km la ecuator)
ETOPO_BANDS = [(-90, -45), (-45, 0), (0, 45), (45, 90)]


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"[skip] {dest.name} exista deja")
        return
    print(f"[get ] {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    tmp.rename(dest)
    print(f"[done] {dest.name}  {dest.stat().st_size / 1e6:.1f} MB")


def main() -> None:
    # Luna - LOLA
    for name in ("ldem_75s_240m.img", "ldem_75s_240m.lbl"):
        download(LOLA_BASE + name, RAW / name)

    # Pamant - ETOPO1 pe benzi de latitudine (ERDDAP limiteaza marimea unui raspuns)
    for lo, hi in ETOPO_BANDS:
        q = f"?altitude[({lo}):{ETOPO_STRIDE}:({hi})][(-180):{ETOPO_STRIDE}:(180)]"
        download(ERDDAP + q, RAW / f"etopo_{lo}_{hi}.nc")

    # Datele climatice NASA (MODIS, GPM) se descarca separat, cu token: pipeline/fetch_nasa.py


if __name__ == "__main__":
    main()
