"""Descarca date NASA pentru Pamant prin OPeNDAP (doar variabilele necesare, la rezolutie redusa).

  - MODIS MOD11C3 v061 : temperatura suprafetei (zi si noapte), lunar, 2020-2024   [NASA LP DAAC]
  - GPM IMERG 3IMERGM v07 : precipitatii lunare, 2020-2024                          [NASA GES DISC]

Autentificare: token NASA Earthdata, citit din fisierul D:\\alba\\.earthdata_token
(o singura linie) sau din variabila de mediu EARTHDATA_TOKEN. Token-ul nu e afisat nicaieri.

Rulare:  python pipeline/fetch_nasa.py
"""
from pathlib import Path
import os
import re
import sys
import time
import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "nasa"
RAW.mkdir(parents=True, exist_ok=True)

CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
OPENDAP = "https://opendap.earthdata.nasa.gov/collections/{cid}/granules/{gid}"
TEMPORAL = "2020-01-01T00:00:00Z,2024-12-31T23:59:59Z"

PRODUCTS = {
    # id colectie, variabile cautate, pas de esantionare (MODIS 0,05° x5 = 0,25°; GPM 0,1° x5 = 0,5°)
    "modis_lst": {"cid": "C2565788897-LPCLOUD", "vars": ["LST_Day_CMG", "LST_Night_CMG"], "stride": 5},
    "gpm_precip": {"cid": "C2723754851-GES_DISC", "vars": ["precipitation"], "stride": 5},
}


def token() -> str:
    t = os.environ.get("EARTHDATA_TOKEN")
    f = ROOT / ".earthdata_token"
    if not t and f.exists():
        t = f.read_text(encoding="utf8").strip()
    if not t:
        sys.exit("Lipseste token-ul: salveaza-l in D:\\alba\\.earthdata_token (vezi README).")
    return t


def granules(cid: str) -> list[str]:
    r = requests.get(CMR, params={"collection_concept_id": cid, "temporal": TEMPORAL, "page_size": 200}, timeout=60)
    r.raise_for_status()
    return [e["title"] for e in r.json()["feed"]["entry"]]


def get(session: requests.Session, url: str, **kw) -> requests.Response:
    for attempt in range(5):
        try:
            r = session.get(url, timeout=300, **kw)
            if r.status_code in (401, 403):
                sys.exit(f"Acces refuzat ({r.status_code}). Verifica token-ul si, pentru GPM, "
                         "aprobarea aplicatiei 'NASA GESDISC DATA ARCHIVE' in profilul Earthdata.")
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            print(f"    reincercare {attempt + 1}: {type(e).__name__}")
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(url)


def var_paths(session: requests.Session, base: str, names: list[str]) -> dict[str, tuple[str, list[int]]]:
    """Gaseste calea completa si dimensiunile fiecarei variabile din descrierea DMR a fisierului."""
    dmr = get(session, base + ".dmr").text
    dims = {m.group(1): int(m.group(2)) for m in re.finditer(r'<Dimension name="([^"]+)" size="(\d+)"', dmr)}
    out = {}
    for name in names:
        m = re.search(r'<(?:Int16|UInt16|Float32|Float64|UInt8)\s+name="%s">(.*?)</' % re.escape(name), dmr, re.S)
        if not m:
            sys.exit(f"Nu gasesc variabila {name} in {base}")
        block = m.group(1)
        shape = []
        for d in re.findall(r'<Dim name="([^"]+)"', block):
            key = d if d in dims else d.split("/")[-1]
            shape.append(dims.get(key) or next(v for k, v in dims.items() if k.endswith(d.split("/")[-1])))
        # calea completa = grupurile parinte + nume
        prefix = dmr[:m.start()]
        groups = []
        for g in re.finditer(r'<Group name="([^"]+)">|</Group>', prefix):
            if g.group(1):
                groups.append(g.group(1))
            elif groups:
                groups.pop()
        out[name] = ("/" + "/".join(groups + [name]), shape)
    return out


def main() -> None:
    s = requests.Session()
    s.headers["Authorization"] = f"Bearer {token()}"
    for key, p in PRODUCTS.items():
        titles = granules(p["cid"])
        print(f"[{key}] {len(titles)} fisiere lunare")
        paths = None
        for title in titles:
            dest = RAW / f"{key}_{re.sub(r'[^A-Za-z0-9._-]', '_', title)}.nc4"
            if dest.exists() and dest.stat().st_size > 0:
                continue
            base = OPENDAP.format(cid=p["cid"], gid=requests.utils.quote(title, safe=""))
            if paths is None:
                paths = var_paths(s, base, p["vars"])
                print("   variabile:", {k: v for k, v in paths.items()})
            ce = ";".join(
                path + "".join(f"[0:{p['stride'] if n > 1 else 1}:{n - 1}]" for n in shape)
                for path, shape in paths.values()
            )
            r = get(s, base + ".dap.nc4", params={"dap4.ce": ce})
            dest.write_bytes(r.content)
            print(f"   {title}  {len(r.content) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
