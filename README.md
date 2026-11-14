# Analog Finder – prototip

Găsește zone de pe Pământ care seamănă cu locul unei misiuni viitoare (pentru început, **Malapert Massif**, regiune candidată Artemis III la polul sud lunar) și arată toate criteriile luate în calcul.

## Structură

```
pipeline/
  fetch_data.py        descarcă datele brute în raw/
  criteria.py          lista criteriilor (nume, unități, surse, explicații) și limitele analogiei
  common.py            formule comune Pământ/Lună (teren, iluminare, presiune)
  build_earth_grid.py  calculează criteriile pentru fiecare celulă de 0,5° de uscat  -> app/data/earth_grid.json
  build_target.py      calculează profilul fiecărei ținte din targets.json           -> app/data/targets.json
  targets.json         lista țintelor (adaugi aici o regiune nouă)
app/
  index.html, app.js, style.css   interfața (hartă + criterii + zone găsite)
  data/                           fișierele JSON generate + analogi cunoscuți
raw/                              date brute descărcate (nu se publică)
```

## Pornire rapidă (fără să descarci date)

Fișierele generate din `app/data/` sunt incluse în repository, deci aplicația merge direct:

```bash
python -m http.server 8765 --directory app
```

Apoi deschide http://localhost:8765.

## Regenerare completă a datelor

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python pipeline/fetch_data.py
.venv/Scripts/python pipeline/fetch_nasa.py      # cere token Earthdata în .earthdata_token
.venv/Scripts/python pipeline/build_earth_grid.py
.venv/Scripts/python pipeline/build_target.py
.venv/Scripts/python -m http.server 8765 --directory app
```

Apoi deschide http://localhost:8765.

## Date folosite

| Ce | Sursă | Rezoluție |
|---|---|---|
| Relief Lună | NASA LRO LOLA `LDEM_75S_240M` (PDS) | 240 m, mediat la 3,6 km |
| Temperaturi și gheață Lună | NASA LRO Diviner Polar Resource Product (PDS), descărcat parțial | ~0,5 km |
| Relief Pământ | NOAA ETOPO1 (ERDDAP), eșantionat la 2′ | ~3,7 km |
| Temperatura suprafeței Pământ | NASA MODIS Terra MOD11C3 v061, lunar 2020–2024 (OPeNDAP) | 0,25°, agregat la 0,5° |
| Precipitații Pământ | NASA GPM IMERG Final 3IMERGM v07, lunar 2020–2024 (OPeNDAP) | 0,5° |
| Hartă de bază | NASA GIBS Blue Marble | — |

## Cum adaugi o țintă nouă

1. Adaugă în `pipeline/targets.json` un obiect cu `id`, `name`, `body: "moon"`, `lat`, `lon`, `window_km`.
2. Rulează `pipeline/build_target.py`.
3. Reîncarcă pagina: ținta apare în lista de sus.

Fișierul LOLA acoperă tot polul sud (75–90°S), deci merge pentru toate cele 9 regiuni Artemis. Pentru Marte trebuie adăugate datele MOLA/THEMIS (pas viitor).

## Limite cunoscute ale prototipului

- Celulele de pe Pământ au 0,5° (~55 km); o regiune de aterizare are ~15 km. Fereastra țintei e mărită la 50 km ca scara să fie aceeași.
- MODIS LST e măsurat doar pe cer senin, deci poate subestima iernile noroase; pe Lună, Diviner dă media la 2 cm sub suprafață.
- „Gheață în sol” pe Pământ e o aproximare (temperatura medie anuală a suprafeței < −5 °C), nu o hartă reală de permafrost.
- Relieful Pământului vine de la NOAA, nu de la NASA: NASADEM/SRTM nu acoperă latitudinile peste 60°N și sub 56°S.

## Token Earthdata

Creează un token la https://urs.earthdata.nasa.gov (Generate Token) și pune-l, pe o singură linie, în `.earthdata_token` la rădăcina proiectului. Fișierul e în `.gitignore`. Pentru GPM aprobă aplicația „NASA GESDISC DATA ARCHIVE” în profilul Earthdata.
- Lista analogilor cunoscuți e orientativă (coordonate aproximative).
