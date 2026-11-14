# Analog Finder: planul criteriilor

Data: 2026-11-14. Document de plan: criteriile marcate **existent** sunt deja în cod
(`pipeline/criteria.py`), restul sunt de adăugat.

Site-ul compară o țintă de pe Lună sau Marte cu fiecare celulă de uscat de pe Pământ
și dă un scor de asemănare. Criteriile sunt împărțite în 8 grupe; fiecare grupă are un scor
propriu, care se desface în subcriterii.

## Cuprins

- [Cum se ajunge de la date la scor](#cum-se-ajunge-de-la-date-la-scor)
- [1. Relief](#1-relief)
- [2. Lumină și umbră](#2-lumină-și-umbră)
- [3. Temperatură](#3-temperatură)
- [4. Atmosferă](#4-atmosferă)
- [5. Apă și gheață](#5-apă-și-gheață)
- [6. Suprafață și minerale](#6-suprafață-și-minerale)
- [7. Viață](#7-viață)
- [8. Subteran](#8-subteran)
- [Ce nu este criteriu](#ce-nu-este-criteriu)
- [Surse și licențe](#surse-și-licențe)
- [De verificat înainte de implementare](#de-verificat-înainte-de-implementare)

---

## Cum se ajunge de la date la scor

```
  DATE BRUTE                 VALORI                     SCORURI                 REZULTAT
  ----------                 ------                     -------                 --------
  sateliți, modele   -->  o valoare per criteriu  -->  scor 0..1 per     -->  scor per grupă
  de relief,              pentru fiecare celulă        criteriu               (medie ponderată)
  reanalize               de 0,5° de pe Pământ              ^                       |
                                                            |                       v
  aceleași formule   -->  o valoare per criteriu  ----------+                 scor total al
  pe Lună / Marte         pentru țintă                                        celulei, 0..100
```

De ce așa: aceeași formulă se aplică pe Pământ și pe țintă, la aceeași scară, ca valorile să fie
comparabile. Scorul nu spune „cât de bun e locul”, ci „cât de mult seamănă cu ținta aleasă”.

### Stări

- **existent**: e deja în site.
- **nou**: de adăugat, cu sursa de date identificată.
- **nou, pe situri**: se calculează doar pentru siturile candidate (cele mai bune 1% din celule)
  și pentru siturile introduse manual, fiindcă cere date la rezoluție fină.

### Cele patru tipuri de scor

**A. Potrivire cu ținta** (formula existentă, `app/app.js`)

```
  scor = sqrt( sRang × sValoare )

  sRang    = ( 1 − | rang(x) − rang(țintă) | ) ^ 6
  sValoare = ( max(0, 1 − | x − țintă | / interval) ) ^ 2
```

- `x` este valoarea celulei, `rang(x)` este percentila ei între toate celulele de pe Pământ (0..1).
- `interval` este diferența dintre maximul și minimul întâlnite pe Pământ.
- Valoarea țintei e limitată la intervalul de pe Pământ.

```
  scor
   1 |            /\
     |           /  \
     |          /    \
   0 |_________/      \_________
               ^ ținta           valoare
```

De ce două componente: `sValoare` răsplătește apropierea în unități reale (grade, metri),
iar `sRang` răsplătește raritatea. Dacă ținta are o valoare extremă, contează doar celulele
care sunt și ele extreme pe Pământ. Exponentul 6 face vârful îngust.

**B. Mai puțin e mai bine / mai mult e mai bine** (nou)

```
  mai puțin e mai bine:  scor = clip( (prag_sus − x) / (prag_sus − prag_jos), 0, 1 )
  mai mult e mai bine:   scor = clip( (x − prag_jos) / (prag_sus − prag_jos), 0, 1 )
```

```
  scor                      scor
   1 |______                 1 |          ______
     |      \                  |         /
     |       \                 |        /
   0 |        \______        0 |_______/
        jos   sus                  jos   sus
     mai puțin e mai bine      mai mult e mai bine
```

De ce: unele ținte nu au o valoare de „potrivit” (vegetația pe Marte e zero și atât).
Pragurile fixe țin scorul stabil de la o rulare la alta.

**C. Da/nu**: 1 dacă celula și ținta au aceeași valoare, 0 altfel.

**D. Nu se aplică**: criteriul e scos din calcul pentru ținta respectivă și apare estompat,
cu motivul scris (de exemplu „Praf: nu se aplică pe Lună”).

### Scorul total (formula existentă)

```
  total = ( Σ pondere_k × scor_k / Σ pondere_k ) × sqrt( Σ pondere_k cu date / Σ pondere_k toate )
```

De ce al doilea factor: o celulă cu date lipsă nu trebuie să câștige doar fiindcă are
mai puține criterii la care poate pierde.

Ponderile vin din presetarea pe scop (mobilitate, energie solară și praf, radar, foraj și gheață,
astrobiologie, peșteri) și pot fi reglate la nivel de grupă sau de subcriteriu.

---

## 1. Relief

Toate valorile se calculează pe o fereastră de circa 50 km, pe o grilă de circa 3,7 km,
identică pe Pământ, Lună și Marte (`pipeline/common.py`, funcția `terrain_stats`).

```
   înălțime z
       |            . z95 .........
       |          /\        ^
       |    /\   /  \       |  variație de relief = z95 − z5
       |   /  \_/    \      v
       |__/ . . . . . \____ z5 ....
       |
       |    panta = unghiul θ:      /|
       |                           / | dz
       |                          /θ_|
       |                           dx
```

| Subcriteriu | Stare | Scor | Formulă |
|---|---|---|---|
| Altitudine | existent, doar afișată | fără scor | `media(z)` pe fereastră |
| Pantă medie | existent | Potrivire | `panta = arctan( sqrt( (dz/dx)² + (dz/dy)² ) )`, apoi media pe fereastră |
| Pantă P90 | existent | Potrivire | percentila 90 a pantelor din fereastră |
| Variație de relief | existent | Potrivire | `z95 − z5` (percentilele 95 și 5 ale altitudinii) |
| Rugozitate | existent | Potrivire | se potrivește un plan `z ≈ a + b·x + c·y` prin fereastră; rugozitatea este abaterea standard a diferențelor față de plan |
| Rugozitate locală (TRI) | nou, pe situri | Potrivire | `TRI = sqrt( Σ (z_vecin − z_centru)² )` peste cei 8 vecini ai fiecărui pixel |
| Depresiuni închise: suprafață | nou | Potrivire | se „umple” relieful cu apă imaginară până dă pe dinafară; `adâncime = relief_umplut − relief`; `f = fracția pixelilor din fereastră cu adâncime > 10 m` |
| Depresiuni închise: adâncime | nou | Potrivire | media adâncimii peste pixelii cu adâncime > 10 m |
| Crater bine păstrat în apropiere | nou | Bonus | `scor = 1` dacă distanța `d` până la un crater de mărime asemănătoare e sub `X = 50 km`, altfel `e^(−d / X)` |

```
   Depresiuni închise: ce rămâne „sub apă” după umplere

      ____            ________          relief umplut  - - - - - - - - -
          \          /                                 \~~~~~~~~~~~~~~/
           \________/   <- crater, calderă, dolină      \____________/  adâncime = umplut − relief
```

```
   TRI: fiecare pixel e comparat cu cei 8 vecini      Rugozitate: ce rămâne după ce scoți înclinarea
        +----+----+----+                                    . .   .
        | z1 | z2 | z3 |                                 .   / . plan potrivit
        +----+----+----+                                   /.     .
        | z4 | z0 | z5 |                                 / .  abaterile față de plan
        +----+----+----+                               /        -> abaterea lor standard
        | z6 | z7 | z8 |
        +----+----+----+
```

**Cum a fost măsurat și cum îl calculăm**

| Date | Cum au fost măsurate | Cum le prelucrăm |
|---|---|---|
| Relief Pământ (ETOPO) | Model global asamblat de NOAA din măsurători radar din satelit și navetă, altimetrie și sondaje. | 1. Se descarcă în 4 benzi de latitudine, la 2′. 2. Pentru fiecare celulă de 0,5° se taie o fereastră de circa 50 km. 3. Se aplică `terrain_stats` pe fereastră. |
| Relief Lună (LOLA) | Altimetru laser pe orbiterul LRO: trimite impulsuri laser și cronometrează întoarcerea. `înălțime = viteza luminii × timp / 2`. | 1. Se taie fereastra din jurul țintei. 2. Se aduce la circa 3,7 km. 3. Aceeași funcție `terrain_stats`. |
| Relief Marte (MOLA) | Altimetru laser pe Mars Global Surveyor, același principiu. | Aceiași pași ca la Lună. |
| Depresiuni închise | Calculate din aceleași modele de relief, cu aceeași formulă pe toate cele trei corpuri. | 1. Se aplică un algoritm de umplere a depresiunilor pe fereastra de relief. 2. Se scade relieful original din cel umplut. 3. Se numără pixelii cu adâncime peste 10 m și se face media adâncimii lor. |
| Cratere de impact pe Pământ | Baza de date Earth Impact Database: circa 190 de structuri confirmate prin studii de teren, cu poziție, diametru, vârstă și stare. | 1. Se păstrează craterele expuse și bine conservate. 2. Pentru fiecare celulă se calculează distanța până la cel mai apropiat crater cu diametru în intervalul ×2 față de cel al țintei. Se publică doar distanța, nu tabelul. |
| Cratere pe Lună și Marte | Cataloagele Robbins: cratere identificate și măsurate manual pe imagini și pe modele de relief (Lună: circa 1,3 milioane peste 1 km; Marte: 384.343 peste 1 km). | Pentru cardul țintei: numărul de cratere pe 10.000 km² în fereastră și diametrul celui mai mare. |

Pașii din `terrain_stats`, în ordine:

```
  fereastră de altitudini z
        |
        +--> gradient pe x și y --> pantă per pixel --> medie (pantă medie), percentila 90 (pantă P90)
        +--> percentilele 5 și 95 ale lui z --> z95 − z5 (variație de relief)
        +--> plan potrivit prin z --> diferențe față de plan --> abatere standard (rugozitate)
        +--> media lui z (altitudine)
```

**De ce contează**
- Panta decide siguranța la aterizare și dacă un rover poate urca.
- Pantă P90 arată cât de dur e cel mai dur teren, chiar dacă media e blândă.
- Variația de relief deosebește un masiv (Malapert se ridică mii de metri) de o câmpie.
- Rugozitatea deosebește terenul frământat (cratere, creste) de o simplă pantă uniformă.
  De aceea se scoate planul înainte: o pantă netedă nu e „rugoasă”.
- Pereții abrupți expun straturile geologice, de aceea țintele de astrobiologie sunt adesea în cratere și canioane.
- Craterele sunt principalul pericol la aterizare și principalul obstacol pentru rovere, care trebuie să intre în ele și să iasă. La polii Lunii, marginea craterului e luminată, iar fundul e veșnic umbrit și păstrează gheața. Pe Marte, craterele au adăpostit lacuri (Jezero, Gale).

**Surse**
- Pământ: NOAA ETOPO1 la 2′ (circa 3,7 km). ETOPO1 e retras de NOAA; de trecut la ETOPO 2022.
- Lună: LRO LOLA (LDEM_75S_240M la pol, LDEM_16 în rest), adus la circa 3,6–3,8 km.
- Marte: MGS MOLA MEGDR, 16 pixeli/grad (circa 3,7 km).
- TRI pe situri: Copernicus GLO-30 sau GLO-90.

**Ce am folosit și de ce**

| Ce am folosit | De ce asta și nu altceva |
|---|---|
| Aceeași funcție `terrain_stats` pe Pământ, Lună și Marte | Valorile sunt comparabile doar dacă formula și scara sunt identice. |
| Scara comună de circa 3,7 km | E rezoluția la care există date globale pentru toate cele trei corpuri (MOLA 16 pixeli/grad). Un model mai fin doar pe Pământ ar face Pământul să pară mai accidentat. |
| ETOPO pentru Pământ | E global, inclusiv la poli, gratuit și fără cont. SRTM se oprește la 60°N și 56°S, deci ar pierde Arctica și Antarctica. |
| Percentilele 5 și 95 pentru variația de relief, nu minim și maxim | Un singur pixel greșit sau un vârf izolat nu schimbă rezultatul. |
| Rugozitate după scoaterea planului | Altfel o pantă netedă ar ieși „rugoasă” și s-ar suprapune cu criteriul de pantă. |
| Depresiuni închise în loc de numărătoare de cratere | Pământul are prea puține cratere pentru o comparație de densitate; forma de „groapă închisă” se poate măsura la fel pe toate cele trei corpuri. |
| Cataloagele Robbins pentru Lună și Marte | Sunt cele mai complete cataloage publice, cu diametre măsurate. |

**Limite**
- Panta depinde de scara la care e măsurată. De aceea toate cele trei corpuri sunt aduse la circa 3,7 km. La scara asta nu se văd bolovani sau cratere mici.
- TRI la 30–90 m descrie terenul la scară de versant, tot nu bolovanii (metri).
- Pământul are circa 190 de cratere de impact confirmate, majoritatea erodate sau îngropate: în jur de 0,01 la 10.000 km², față de circa 340 pe Lună și circa 27 pe Marte (cratere peste 1 km). O potrivire de „densitate de cratere” e imposibilă, de aceea se folosesc depresiunile închise.
- Depresiunile închise măsoară forma, nu originea: pe Pământ prind și caldere, doline și bazine secate. La scara de 3,7 km se văd doar depresiuni mai late de circa 10 km.
- Earth Impact Database nu are licență afișată, deci publicăm doar distanțe derivate și o cităm.

---

## 2. Lumină și umbră

```
   Poziția soarelui                              Umbra unui obstacol

            * soare                                       * soare (elevație e)
           /                                            .
          /  elevație e                               .
   ______/_)______________ orizont              |h  .
                                                |. e
                                                +---------------- L = h / tan(e)
```

Elevația soarelui la un moment dat:

```
  sin(e) = sin(φ)·sin(δ) + cos(φ)·cos(δ)·cos(H)

  φ = latitudinea        δ = declinația soarelui        H = unghiul orar
  δ(zi) = înclinarea_axei × sin( 2π × zi / an )
```

Înclinarea axei: Pământ 23,44°, Lună 1,54°, Marte 25,19°.

| Subcriteriu | Stare | Scor | Formulă |
|---|---|---|---|
| Soare jos | existent | Potrivire | `100 × (ore cu 0 < e < 10°) / (ore cu e > 0)`, pe un an, cu pas de 5 minute (`low_sun_fraction`) |
| Zi polară | nou | Potrivire | numărul de zile cu `|φ| + δ·semn(φ) − 90° > −0,83°` (soarele nu coboară sub orizont) |
| Noapte polară | nou | Potrivire | numărul de zile cu `90° − |φ| + δ·semn(φ) < −0,83°` (soarele nu urcă peste orizont) |
| Umbră de relief: fracție | nou, pe situri | Potrivire | `(ore de zi cu e < orizont_local(direcția soarelui)) / (ore de zi)` |
| Umbră de relief: durată | nou, pe situri | Potrivire | cel mai lung șir de zile consecutive fără nicio oră de soare direct |

```
   Umbră de relief: soarele e deasupra orizontului plat, dar sub creasta din față

        * soare
          \            /\  creastă
           \          /  \
            \  e     /    \         orizont_local = unghiul sub care se vede creasta
   _________ \)_____/__x___\____    dacă e < orizont_local, punctul x e în umbră
```

**Cum a fost măsurat și cum îl calculăm**

Criteriile astronomice nu folosesc măsurători: sunt calcule geometrice din latitudine și înclinarea axei.

| Date | Cum au fost obținute | Cum le prelucrăm |
|---|---|---|
| Soare jos | Calcul, fără instrument. | 1. Se generează declinația soarelui pentru 365 de zile. 2. Pentru fiecare zi se calculează elevația la fiecare 5 minute (288 de momente). 3. Se numără momentele cu soarele între 0° și 10° și se împart la momentele cu soarele deasupra orizontului. |
| Zi și noapte polară | Calcul, fără instrument. | 1. Pentru fiecare zi se calculează elevația minimă și maximă a soarelui. 2. Se numără zilele în care minima e peste orizont (zi polară) sau maxima e sub orizont (noapte polară). Pragul de −0,83° ține cont de refracția aerului și de mărimea discului solar. |
| Umbră de relief | Relieful vine dintr-un model de relief (GLO-30/90: radar din satelit; LOLA și MOLA: altimetru laser). | 1. Din punctul analizat se privește în 72 de direcții și se notează cel mai înalt unghi sub care se vede terenul: orizontul local. 2. Pentru fiecare oră din an se compară elevația soarelui cu orizontul din direcția lui. 3. Se numără orele în umbră și cel mai lung șir de zile fără soare direct. |

Același calcul se face pentru țintă cu înclinarea axei ei (Lună 1,54°, Marte 25,19°).
Modelul ignoră refracția la „soare jos” și, în varianta existentă, ignoră relieful.

**De ce contează**
- La polul sud lunar soarele stă mereu aproape de orizont. Umbrele sunt foarte lungi: la 1,5° elevație, un om de 1,8 m aruncă o umbră de circa 69 m.
- Umbrele lungi și contrastul puternic pun probleme camerelor și navigației; panourile solare trebuie montate vertical.
- Durata fără soare direct decide câtă energie trebuie stocată.
- Zilele de lumină continuă contează pentru testele de energie solară și pentru ritmul de somn al echipajelor.

**Surse**
- Calcul astronomic din latitudine, fără date externe.
- Orizontul local: Copernicus GLO-30 sau GLO-90 (Pământ), LOLA (Lună), MOLA (Marte).

**Ce am folosit și de ce**

| Ce am folosit | De ce asta și nu altceva |
|---|---|
| Calcul astronomic din latitudine | Poziția soarelui e geometrie exactă; nu are nevoie de măsurători și se aplică identic pe orice corp, schimbând doar înclinarea axei. |
| Pragul de 10° pentru „soare jos” | Sub 10° umbrele sunt de peste 5 ori mai lungi decât obstacolul, adică regimul care pune probleme camerelor. |
| Orizont local din modelul de relief, nu o singură imagine de umbrire | O umbrire cu unghi fix arată un singur moment; orizontul local permite calculul pentru fiecare oră din an. |
| Model de relief, nu fotografii din satelit | În fotografii un nor poate fi confundat cu o umbră, iar o fotografie prinde o singură oră. |
| Două valori pentru umbră (fracție și durată) | Fracția arată cât de des e umbră; durata arată cât trebuie să reziste echipamentul fără soare. Două locuri pot avea aceeași fracție și durate foarte diferite. |

**Limite**
- Pe Pământ nu există umbră permanentă adevărată. Există locuri unde umbra domină: văi adânci, pereți orientați spre nord, chei.
- Umbra terestră nu reproduce frigul din craterele lunare umbrite (25–40 K). Criteriul servește testelor de camere, navigație și energie solară.
- Nici pe Lună nu există „vârfuri de lumină eternă”: cele mai bune creste sunt luminate circa 92–96% din timp, cu întuneric de 1,5 până la 5 zile.
- Pe Lună umbrele nu sunt negru absolut: primesc lumină reflectată de terenul luminat din jur.
- Islanda nu are soare continuu săptămâni la rând (doar insula Grímsey trece de Cercul Polar). Pentru soare jos persistent sunt mai potrivite Devon Island (75°N, circa 110 zile de lumină continuă) sau Svalbard (79°N, circa 133 de zile).

---

## 3. Temperatură

```
   temperatura solului
        |        ___
        |      /     \            T_zi
        |     /       \
        |    /         \          amplitudine = T_zi − T_noapte
        |___/           \_____    T_noapte
        +------------------------- oră
          dimineață  amiază  noapte
```

| Subcriteriu | Stare | Scor | Formulă |
|---|---|---|---|
| Temperatură medie | existent | Potrivire | `media pe 12 luni a (T_zi + T_noapte) / 2` |
| Temperatură maximă | existent | Potrivire | `maximul pe 12 luni al T_zi` (luna cea mai caldă) |
| Amplitudine zi/noapte | existent (`t_swing`) | Potrivire | `media(T_zi − T_noapte)`; pe Lună: maxim minus minim pe o zi lunară |

**Cum a fost măsurat și cum îl calculăm**

| Date | Cum au fost măsurate | Cum le prelucrăm |
|---|---|---|
| Temperatura solului pe Pământ (MODIS MOD11C3) | Instrumentul MODIS de pe satelitul Terra măsoară radiația infraroșie termică emisă de sol, în două benzi (în jur de 11 și 12 µm). Diferența dintre benzi corectează efectul atmosferei. Satelitul trece o dată ziua și o dată noaptea. Măsoară doar pe cer senin. | 1. Se descarcă mediile lunare zi și noapte, 2020–2024. 2. Se face media pe fiecare lună calendaristică. 3. Medie: media celor 12 luni din `(zi + noapte) / 2`. Maximă: cea mai mare valoare de zi. Amplitudine: media `zi − noapte`. 4. Se agregă de la 0,05° la celule de 0,5°. |
| Temperatura pe Lună (Diviner) | Radiometru în infraroșu termic pe orbiterul LRO: măsoară căldura emisă de suprafață în mai multe benzi și o transformă în temperatură. | 1. Se citesc valorile din jurul țintei (medie și maximă din produsul polar). 2. Pentru amplitudine: maxim minus minim peste cele 96 de intervale de oră locală din produsul global. |
| Temperatura pe Marte (MACDA) | Nu e măsurătoare directă: e o reanaliză. Un model al atmosferei marțiene e corectat continuu cu temperaturile și praful măsurate din orbită în infraroșu. | 1. Se alege un an marțian fără furtună globală. 2. Se ia celula care conține ținta. 3. Se calculează media, minima și maxima variabilei `tsurf` pe tot anul. |

**De ce contează**
- Regimul termic decide ce materiale, baterii și lubrifianți rezistă și dacă gheața rămâne stabilă.
- Ciclul zi/noapte obosește materialele: deformarea e `ε = α × ΔT` (α este coeficientul de dilatare al materialului). Lipiturile, garniturile și articulațiile cedează după multe cicluri.
- Se folosește temperatura solului măsurată din satelit, nu temperatura aerului: solul uscat se încălzește și se răcește mult mai tare decât aerul.

**Surse**
- Pământ: NASA MODIS MOD11C3 v061 (temperatura solului zi și noapte, lunar, 2020–2024).
- Lună: LRO Diviner (produsul polar pentru medie și maximă; produsul global cumulat pentru amplitudine).
- Marte: de adăugat din reanaliza MACDA v2.0, variabila `tsurf`, pe un an marțian fără furtună globală.

**Ce am folosit și de ce**

| Ce am folosit | De ce asta și nu altceva |
|---|---|
| Temperatura solului, nu a aerului | Echipamentul stă pe sol, iar solul uscat variază mult mai tare decât aerul. Și pe Lună și Marte se măsoară tot temperatura suprafeței, deci comparația e între mărimi de același fel. |
| MODIS MOD11C3 | Dă direct temperatura de zi și de noapte, global, lunar, la o rezoluție apropiată de grila noastră, fără prelucrare grea. |
| Media pe 2020–2024 | Cinci ani netezesc un an neobișnuit, fără să ceară descărcări mari. |
| Diviner pentru Lună | E singurul instrument care a cartografiat temperatura întregii suprafețe lunare, la toate orele locale. |
| MACDA pentru Marte, nu Mars Climate Database | Licența MACDA permite explicit orice utilizare cu citare; Mars Climate Database nu acordă dreptul de a publica valori derivate. |
| Un an marțian fără furtună globală | Furtunile schimbă temperatura la sol; scenariul normal trebuie să reflecte un an obișnuit. |

**Limite**
- Pământul ajunge la circa 40 °C diferență zi/noapte, Marte la 80–100 °C, Luna la circa 280 °C. Ținta depășește orice valoare terestră, deci cele mai bune celule reproduc doar o parte din șoc.
- Reanaliza pentru Marte are celule de circa 300 km și 12 valori pe zi, deci extremele reale sunt puțin mai mari.

---

## 4. Atmosferă

```
   Cum taie praful lumina soarelui

      * soare
       \\\\\        lumină directă la sol = lumină_sus × e^(−τ / sin e)
     ~~~~~~~~~~~
     ~ praf, τ ~    τ = opacitatea coloanei de praf
     ~~~~~~~~~~~    τ = 0,5  -> trece circa 61% din lumina directă (soare la zenit)
        \\\         τ = 5    -> trece sub 1%
   ______\\_____    τ = 10,8 -> practic zero (furtuna din 2018 de pe Marte)
```

| Subcriteriu | Stare | Scor | Formulă |
|---|---|---|---|
| Presiune | existent | Potrivire pe Lună; nu se aplică pe Marte | Pământ: `p = 1013,25 × (1 − 2,25577·10⁻⁵ × z)^5,25588` hPa. Marte: `p = 6,1 × e^(−z / 11,1 km)` hPa (doar afișată) |
| Praf, scenariu normal | nou | Potrivire | `scor = clip( 1 − | log10( τ_Pământ / τ_țintă ) | / log10(20), 0, 1 )`, cu τ medii |
| Praf, scenariu furtună | nou | Mai mult e mai bine | `0,30·n(P95) + 0,30·n(zile) + 0,25·n(episod) + 0,15·n(medie)`, unde `n(x) = clip(x / plafon, 0, 1)` |
| Vânt: forță echivalentă | nou | Potrivire | vântul țintei se transformă în vântul terestru care apasă la fel: `v_echivalent = v_Marte × sqrt( ρ_Marte / ρ_Pământ ) ≈ 0,12 × v_Marte`. Se compară cu percentila 95 a vântului de pe Pământ |
| Vânt: nisip și praf ridicat | nou | Mai mult e mai bine | `SP = fracția orelor cu u* > 0,25 m/s`, unde `u* = 0,4 × v10 / ln(10 / z0) ≈ 0,058 × v10`; apoi `SP × (1 − vegetație) × sol_uscat` |

```
   De ce un vânt puternic pe Marte apasă slab

   forța vântului pe o suprafață  ~  ½ × ρ × v²        ρ = densitatea aerului

   Pământ: ρ ≈ 1,2 kg/m³      Marte: ρ ≈ 0,015–0,020 kg/m³  (de 60–80 de ori mai mic)

   100 km/h pe Marte  apasă cât  11–13 km/h pe Pământ
```

Componentele scenariului furtună, din valorile zilnice de opacitate `d`:

| Componentă | Definiție | Plafon |
|---|---|---|
| P95 | percentila 95 a lui `d` | 2,0 |
| zile | zile pe an cu `d > 0,5` | 120 |
| episod | cel mai lung șir de zile consecutive cu `d > 0,5` | 15 |
| medie | `media(d)` | 0,6 |

**Cum a fost măsurat și cum îl calculăm**

| Date | Cum au fost măsurate | Cum le prelucrăm |
|---|---|---|
| Presiune pe Pământ | Nu e măsurată: e calculată din altitudinea medie a celulei, cu atmosfera standard. | Se aplică formula barometrică pe altitudinea medie din grupa Relief. |
| Presiune pe Marte | Calculată din altitudinea MOLA. Presiunea reală variază cu ±10–15% pe parcursul anului, fiindcă o parte din atmosferă îngheață la poli iarna. | Se aplică formula exponențială pe altitudinea țintei. |
| Praf pe Pământ (MERRA-2) | Reanaliză NASA: un model global al atmosferei, corectat cu opacitatea aerosolilor măsurată de sateliți și de stații de la sol. Modelul separă partea de praf de restul aerosolilor (fum, sare marină, poluare). | 1. Se descarcă valorile zilnice de opacitate a prafului pe mai mulți ani. 2. Per celulă se calculează media, percentila 95, zilele peste 0,5 și cel mai lung episod. 3. Se aduce la grila de 0,5°. |
| Praf pe Marte (Montabone) | Opacitatea prafului măsurată din orbită în infraroșu de trei instrumente succesive, apoi pusă pe hartă zilnică și adusă la o presiune de referință de 610 Pa. | 1. Se ia celula care conține ținta. 2. Valoare tipică: mediana pe anii fără furtună globală. 3. Vârf de furtună: maximul din anii cu furtună globală. |
| Vânt pe Pământ (MERRA-2) | Reanaliză: vântul la 10 m deasupra solului, din model corectat cu observații de la stații, baloane și sateliți. | 1. Se descarcă componentele orare ale vântului și se calculează viteza `sqrt(u² + v²)`. 2. Per celulă: media, percentila 95 și fracția orelor peste pragul de ridicare a nisipului. |
| Vânt pe Marte | Măsurat direct de stațiile meteo ale landerelor și roverelor (de exemplu Perseverance: 2–4 m/s obișnuit, rafale de circa 25 m/s). Pentru ținte fără lander: reanaliza MACDA, nivelul cel mai de jos. | Se ia viteza tipică și rafala maximă per țintă și se transformă în vânt echivalent. |

**De ce contează**
- Praful din aer taie lumina. Roverul Opportunity producea circa 645 Wh pe zi înainte de furtuna din 2018 și 22 Wh în timpul ei.
- Praful depus pe panouri e un mecanism separat: un strat care crește încet și care a oprit landerul InSight.
- Scenariul normal caută locuri cu praf asemănător zilelor obișnuite de pe Marte. Scenariul furtună caută locurile cu cele mai dese și mai lungi episoade de praf dens, pentru testarea panourilor și a sistemelor de curățare.
- Scara logaritmică se folosește fiindcă efectul prafului depinde de raport, nu de diferență: de la 0,1 la 0,2 e o schimbare la fel de mare ca de la 1 la 2.
- Vântul marțian e rapid, dar aerul e atât de rar încât împinge slab. Ce contează pentru echipamente e ce face vântul cu nisipul și praful: îl ridică, îl depune pe panouri, uneori le curăță, roade suprafețele și formează dune în care roverele s-au împotmolit (Opportunity în 2005, Spirit în 2009).
- Forța echivalentă servește testelor de parașute, aterizare și structuri înalte. Nisipul ridicat servește testelor de murdărire a panourilor, abraziune și mers pe dune.
- Nisipul începe să se miște când viteza de frecare `u*` trece de un prag (circa 0,25 m/s pentru nisip fin, adică vânt de 4–5 m/s la 10 m). Înmulțirea cu „fără vegetație” și „sol uscat” elimină locurile unde bate vântul, dar nu are ce ridica.

**Surse**
- Pământ: NASA MERRA-2, variabila `DUEXTTAU` (opacitatea prafului la 550 nm), 0,5° × 0,625°, din 1980.
- Marte: hărțile Montabone de opacitate a prafului (ani marțieni 24–36); se extrag valoarea tipică și vârful de furtună per țintă.
- Presiunea afișată pentru Marte: din altitudinea MOLA, cu formula de mai sus.
- Vânt pe Pământ: NASA MERRA-2, colecția `M2T1NXSLV` (variabilele `U10M`, `V10M`), orar.
- Vânt pe Marte: măsurători ale landerelor și reanaliza MACDA v2.0 (`uwind`, `vwind`).

**Ce am folosit și de ce**

| Ce am folosit | De ce asta și nu altceva |
|---|---|
| Presiune calculată din altitudine | Presiunea medie depinde aproape numai de altitudine; formula e suficient de precisă și nu cere alt set de date. |
| MERRA-2 `DUEXTTAU` pentru praf | Separă praful de ceilalți aerosoli (fum, poluare, sare marină), are valori zilnice din 1980 și se descarcă cu același cont ca restul datelor NASA. Imaginile din satelit dau doar aerosolii totali și au goluri peste deșerturile luminoase. |
| Hărțile Montabone pentru Marte | Sunt climatologia de referință a prafului marțian, pe 13 ani marțieni, cu acces liber. |
| Două scenarii de praf | O zi obișnuită și o furtună sunt probleme diferite: prima cere potrivire cu ținta, a doua cere cele mai dure condiții disponibile. |
| Zile și episoade, nu doar media | Două locuri cu aceeași medie pot avea praf ușor permanent sau furtuni rare și violente; pentru teste contează a doua situație. |
| Forță echivalentă pentru vânt | Compararea directă a vitezelor ar fi înșelătoare: aerul marțian e de 60–80 de ori mai rar, deci aceeași viteză apasă mult mai slab. |
| MERRA-2 pentru vânt | Aceeași sursă și aceeași grilă ca praful, deci cele două se combină fără reeșantionare. |

**Limite**
- Praful nu se aplică pe Lună: nu există atmosferă și nici furtuni.
- Furtunile terestre ajung la opacitate 3–5 timp de ore sau zile; cea marțiană din 2018 a atins 10,8 și a durat luni. Un sit terestru testează atenuarea luminii, depunerea, abraziunea și curățarea, nu supraviețuirea la luni de întuneric.
- Praful marțian e mai fin și are altă compoziție decât cel terestru.
- Vântul nu se aplică pe Lună. Echivalentul lunar e praful aruncat de jetul motorului la aterizare, care nu se poate deduce din date de vânt.
- Vântul la sol din reanaliza marțiană e slab constrâns de observații; valorile măsurate de landere sunt mai sigure, dar există doar pentru câteva ținte.
- Pe Marte pragul de ridicare a nisipului e de câteva ori mai mare decât pe Pământ, deci un loc terestru cu mult nisip în mișcare exagerează fenomenul.
- Presiunea de pe Marte (circa 6 hPa) nu are echivalent pe Pământ (cel puțin circa 330 hPa pe Everest), de aceea e afișată, dar nu intră în scor.

---

## 5. Apă și gheață

| Subcriteriu | Stare | Scor | Formulă |
|---|---|---|---|
| Precipitații | existent | Potrivire | `suma anuală`, media 2020–2024. Ținta: 0 mm |
| Umiditatea solului | nou | Mai puțin e mai bine | `θ = media multianuală a umidității din primii 5 cm`; `scor = clip( (0,10 − θ) / (0,10 − 0,02), 0, 1 )` |
| Gheață | existent, de extins la Marte | Da/nu | Pământ: 1 dacă `temperatura medie < −5 °C` (permafrost probabil). Lună: gheață stabilă în primul metru (Diviner). Marte: 1 dacă harta SWIM arată consistență pozitivă |

```
   De ce contează umiditatea pentru radar

   antenă  )))  ----->  sol uscat:  unda pătrunde adânc, se întoarce de la straturi
   antenă  )))  -->|    sol umed:   apa absoarbe unda în primii centimetri
```

**Cum a fost măsurat și cum îl calculăm**

| Date | Cum au fost măsurate | Cum le prelucrăm |
|---|---|---|
| Precipitații (GPM IMERG) | Combină radiometre cu microunde de pe mai mulți sateliți (văd direct picăturile și gheața din nori), sateliți geostaționari în infraroșu (umplu golurile dintre treceri) și pluviometre de la sol (calibrare). | 1. Se descarcă totalurile lunare 2020–2024. 2. Se însumează pe an și se face media anilor. 3. Se agregă la celule de 0,5°. |
| Umiditatea solului (SMAP) | Radiometru cu microunde pe satelit: măsoară radiația naturală emisă de sol la 1,4 GHz. Solul umed emite mai puțin decât cel uscat, deci din intensitate se deduce apa din primii 5 cm. | 1. Se descarcă valorile zilnice pe mai mulți ani. 2. Se face media multianuală per pixel. 3. Se agregă de la 9 km la 0,5°. |
| Gheață pe Pământ | Nu e măsurată: e dedusă din temperatura medie a solului (MODIS). | Celula primește 1 dacă temperatura medie e sub −5 °C. |
| Gheață pe Lună (Diviner) | Dedusă din temperaturile măsurate: un model termic calculează la ce adâncime gheața ar rămâne stabilă. | Ținta primește 1 dacă gheața e stabilă în primul metru. |
| Gheață pe Marte (SWIM) | Combină mai multe semnale: hidrogen detectat cu spectrometru de neutroni, comportament termic, radar de subsol și forme de relief tipice gheții. Rezultatul e un indice de la −1 (incompatibil cu gheață) la +1 (compatibil). | Ținta primește 1 dacă indicele din jurul ei e pozitiv. |

**De ce contează**
- Ariditatea extremă e condiția de bază a unui analog: pe Lună și pe Marte nu plouă.
- Apa lichidă din sol atenuează undele radar, deci testele de radar de subsol cer sol uscat, sare uscată sau teren înghețat.
- Gheața e resursa-cheie pentru o bază: apă, oxigen și combustibil.

**Surse**
- Precipitații: NASA GPM IMERG Final 3IMERGM v07, lunar.
- Umiditate: NASA SMAP SPL3SMP_E (9 km, zilnic, din 2015).
- Gheață pe Marte: hărțile SWIM (valori de la −1 la +1, pe trei adâncimi).

**Ce am folosit și de ce**

| Ce am folosit | De ce asta și nu altceva |
|---|---|
| GPM IMERG pentru precipitații | Acoperă și deșerturile și zonele fără stații meteo, unde sunt tocmai locurile care ne interesează. |
| SMAP pentru umiditatea solului | Măsoară direct apa din stratul de sus al solului, global, la 9 km. Precipitațiile singure nu spun cât de umed rămâne solul. |
| Umiditatea solului ca indicator pentru radar | Apa lichidă e principalul lucru care oprește undele radar. O formulă de permitivitate ar cere tipul de rocă din fiecare loc, care nu există ca hartă globală de încredere. |
| Prag de −5 °C pentru gheață pe Pământ | E o aproximare simplă a permafrostului, calculabilă din date pe care le avem deja. |
| SWIM pentru gheața de pe Marte | Combină mai multe instrumente într-un singur indice, deci e mai robust decât oricare instrument luat separat. |

**Limite**
- Pragurile pentru umiditate (0,02 și 0,10 m³/m³) sunt propunerea noastră și trebuie calibrate pe datele reale.
- Gheața pe Pământ e dedusă din temperatură, nu măsurată.

---

## 6. Suprafață și minerale

```
   Lumină reflectată pe benzi (schematic)

   reflectanță
     |                       rocă cu oxizi de fier: roșu mult mai mare decât albastru
     |            ___.---
     |        _.-'                 argile: scădere între SWIR1 și SWIR2
     |    _.-'              ---.___
     |_.-'
     +-----+------+------+------+------
     albastru  roșu   NIR   SWIR1  SWIR2
```

| Subcriteriu | Stare | Scor | Formulă |
|---|---|---|---|
| Albedo | nou | Potrivire | `albedo = lumină reflectată / lumină primită`, medie multianuală |
| Oxizi de fier | nou, pe situri | Mai mult e mai bine | `roșu / albastru` (Sentinel-2: B4 / B2) |
| Minerale argiloase | nou, pe situri | Mai mult e mai bine | `SWIR1 / SWIR2` (Sentinel-2: B11 / B12) |

**Cum a fost măsurat și cum îl calculăm**

| Date | Cum au fost măsurate | Cum le prelucrăm |
|---|---|---|
| Albedo (MODIS MCD43C3) | MODIS vede același loc din unghiuri diferite pe parcursul a 16 zile. Din aceste observații se potrivește un model al felului în care suprafața reflectă lumina în toate direcțiile, iar din model se calculează fracția totală reflectată. | 1. Se descarcă albedoul pe bandă largă. 2. Se face media multianuală, fără pixelii cu zăpadă. 3. Se agregă de la 0,05° la 0,5°. |
| Oxizi de fier și argile (Sentinel-2) | Camera multispectrală a sateliților Sentinel-2 măsoară lumina solară reflectată în 13 benzi, la 10–20 m. Produsul L2A e corectat pentru atmosferă. | 1. Pentru fiecare sit candidat se iau imaginile fără nori dintr-un an. 2. Se face mediana per bandă. 3. Se calculează rapoartele de benzi și se face media pe sit. |

**De ce contează**
- Albedoul decide cât se încălzește suprafața și cum arată în camere. Luna e întunecată (circa 0,07–0,12), deci algoritmii de aterizare vizuală trebuie antrenați pe suprafețe întunecate.
- Oxizii de fier dau culoarea roșie a lui Marte; argilele se formează în apă și păstrează urme organice, de aceea sunt ținte de astrobiologie (Jezero).

**Surse**
- Albedo pe Pământ: NASA MODIS MCD43C3 (0,05°).
- Indici minerali: Sentinel-2 L2A.
- Albedo pentru Lună și Marte: sursă încă nealeasă.

**Ce am folosit și de ce**

| Ce am folosit | De ce asta și nu altceva |
|---|---|
| MODIS MCD43C3 pentru albedo | E un produs de albedo gata calculat, global. Landsat și Sentinel-2 nu au un produs global echivalent. |
| Rapoarte de benzi pentru minerale | Un raport între două benzi anulează în mare parte diferențele de iluminare și pantă, deci compară locuri fotografiate în condiții diferite. |
| Sentinel-2, doar pe situri | Are benzile necesare la 10–20 m, cu acces liber. La scara întregului glob volumul de date ar fi prea mare pentru un prototip. |
| Fără NASA EMIT ca sursă principală | Ar da minerale identificate direct, dar acoperă doar între 52°N și 52°S și doar anumite zone aride. |

**Limite**
- Indicii spectrali arată culoarea suprafeței, nu confirmă mineralul. Confirmarea cere analiză de teren.
- Indicii se activează doar pentru țintele marțiene cu astfel de minerale.
- Pragurile de scor pentru cei doi indici nu sunt încă stabilite.

---

## 7. Viață

```
   Cum vede satelitul plantele (lumină solară reflectată)

   reflectanță      plantă vie                    sol gol / rocă
     |                    ____                          ___----
     |                   |                        ___---
     |      _            |                  ___---
     |_____/ \___________|               ---
     +-----+------+------+---           +-----+------+------+---
          verde  roșu   NIR                  verde  roșu   NIR

     roșu mic, NIR mare -> NDVI mare         roșu ≈ NIR -> NDVI aproape de 0
```

| Subcriteriu | Stare | Scor | Formulă |
|---|---|---|---|
| Vegetație absentă | nou | Mai puțin e mai bine | `NDVI = (NIR − roșu) / (NIR + roșu)`. Se ia maximul anual, apoi mediana pe 3 ani. `scor = clip( (0,2 − NDVI) / 0,1, 0, 1 )` |
| Viață microbiană în sol | nou | Mai puțin e mai bine | `scor = 0,45·W + 0,30·C + 0,15·T + 0,10·V` (detalii mai jos) |

Componentele scorului de viață microbiană:

```
  W (apă)         = clip( (log10(0,2) − log10(AI)) / (log10(0,2) − log10(0,002)), 0, 1 )
  C (carbon)      = clip( (log10(20) − log10(SOC)) / (log10(20) − log10(1)), 0, 1 )
  T (temperatură) = clip( (5 − T_aer_medie) / 30, 0, 1 )
  V (vegetație)   = 1 dacă satelitul nu vede producție vegetală, altfel 0

  AI  = indicele de ariditate (precipitații / evaporare potențială)
  SOC = carbon organic în sol, g/kg
```

**Cum a fost măsurat și cum îl calculăm**

| Date | Cum au fost măsurate | Cum le prelucrăm |
|---|---|---|
| NDVI (MODIS MOD13) | MODIS măsoară lumina solară reflectată în roșu și în infraroșu apropiat. Nu emite nimic: e un senzor pasiv. Din zilele unei perioade se păstrează cea mai bună observație, fără nori. | 1. Se descarcă valorile lunare pe 3 ani. 2. Se maschează zăpada, gheața și apa. 3. Per pixel: maximul fiecărui an, apoi mediana celor 3 ani. 4. Se agregă la 0,5° și se aplică rampa 0,1–0,2. |
| Ariditate (Global Aridity Index) | Nu e măsurătoare directă: raportul dintre precipitațiile medii și evaporarea potențială, ambele calculate din climatologii de stații meteo interpolate. | Se citește valoarea per celulă și se pune pe scară logaritmică. |
| Carbon organic în sol (SoilGrids) | Hartă produsă prin învățare automată: sute de mii de profile de sol analizate în laborator, extinse pe glob cu ajutorul climei, reliefului și imaginilor din satelit. | Se ia stratul 0–5 cm, se agregă de la 250 m la 0,5° și se pune pe scară logaritmică. |
| Temperatura aerului (ERA5-Land) | Reanaliză europeană: model al suprafeței terestre condus de observații meteo. | Media multianuală a temperaturii la 2 m per celulă. |
| Producție vegetală (MODIS MOD17) | Calculată din cât de multă lumină absoarbe vegetația văzută de MODIS. Zonele sterpe nu au valoare. | Celula primește V = 1 dacă nu are valoare. |

În zonele hiperaride și polare, hărțile de sol și de ariditate se bazează pe foarte puține probe
de teren, deci acolo scorul e mai nesigur tocmai unde contează mai mult.

**De ce contează**
- Luna și Marte nu au plante. Vegetația strică trei tipuri de teste: împrăștie undele radar, contaminează solul cu materie organică, iar rădăcinile leagă solul și schimbă felul în care se afundă roțile.
- NDVI vede doar plante, nu microbi. Un loc poate avea NDVI zero și sol viu, de aceea e nevoie de al doilea subcriteriu.
- Pentru testarea instrumentelor de detecție a vieții e nevoie de sol cu cât mai puțină viață, ca semnalul de fond să fie mic.
- De ce maximul anual la NDVI: un loc verde doar două luni pe an tot are plante.
- De ce pragul 0,1 cu rampă până la 0,2: sub 0,1 e sol gol; între 0,1 și 0,2 e vegetație rară; valori sub 0,05 sunt sub zgomotul senzorilor.
- De ce aceste ponderi la viața microbiană: apa disponibilă prezice cel mai bine biomasa, apoi carbonul organic, apoi temperatura.

**Surse**
- NDVI: NASA MODIS MOD13 (produsul lunar la 0,05° pentru grilă; MOD13Q1 la 250 m pentru verificarea siturilor).
- Ariditate: Global Aridity Index v3.1. Carbon: SoilGrids 2.0. Temperatură: ERA5-Land. Producție vegetală: MODIS MOD17.

**Ce am folosit și de ce**

| Ce am folosit | De ce asta și nu altceva |
|---|---|
| NDVI | E indicele de vegetație cel mai răspândit și mai simplu, disponibil global pe peste 20 de ani. |
| Prag 0,1 cu rampă până la 0,2 | 0,1 e limita uzuală pentru sol gol. Un prag mai strict (0,05) ar fi sub zgomotul senzorului; rampa evită o tăietură bruscă pe celule mari, care amestecă terenuri diferite. |
| Maximul anual, nu media | Media ar ascunde vegetația sezonieră. |
| Estimare din climă și sol pentru microbi | Hărțile globale de biomasă microbiană au foarte puține probe în deșerturi și zone polare, iar una dintre ele nu poate fi redistribuită. Ariditatea și carbonul organic sunt factorii care prezic cel mai bine biomasa. |
| Scor treptat, nu prag de eliminare, la microbi | Fiind o estimare, nu trebuie să excludă definitiv un loc. |

**Limite**
- Zăpada, gheața și apa dau și ele NDVI mic, deci trebuie mascate; altfel un ghețar iese „analog perfect”.
- Scorul de viață microbiană e o estimare din climă și sol, nu o măsurătoare. Formula e propunerea noastră, nu o metodă publicată.
- Niciun loc natural de pe Pământ nu e steril. Cel mai sărac sol măsurat (University Valley, Antarctica) are circa 1.400–5.700 celule pe gram.
- O celulă de 55 km ascunde microbi sub pietre, în roci sau în oaze de ceață. Confirmarea cere probe de teren.
- Pentru studiul extremofilelor direcția se inversează: se caută locuri dure care găzduiesc viață.
- Antarctica lipsește din indicele de ariditate și din SoilGrids.

---

## 8. Subteran

```
   suprafață:  +120 °C ziua ... −170 °C noaptea (Lună)
   ___________      ___________________
              |    |   puț / tavan prăbușit
              |    |________________
              |      interior: temperatură aproape constantă,
              |______ protejat de radiații și de praf
```

| Subcriteriu | Stare | Scor | Formulă |
|---|---|---|---|
| Temperatura din peșteră | existent (`cave_temp`) | Potrivire | Pământ: o peșteră se stabilizează aproape de temperatura medie anuală de la suprafață, deci `T_peșteră ≈ temperatura medie`. Lună: temperatura modelată a zonei umbrite a puțului |
| Distanța până la lavă bazaltică tânără | existent (`basalt_dist`) | Potrivire | distanța în km până la cel mai apropiat vulcan bazaltic din Holocen. Ținta: 0 km |
| Intrare cunoscută în subteran | nou | Da/nu | 1 dacă în celulă există o peșteră sau un tub de lavă din lista verificată |

**Cum a fost măsurat și cum îl calculăm**

| Date | Cum au fost obținute | Cum le prelucrăm |
|---|---|---|
| Temperatura din peșteră, Pământ | Nu e măsurată în peșteră: se folosește temperatura medie a solului de la suprafață (MODIS), fiindcă o peșteră se stabilizează aproape de media anuală de deasupra. | Se copiază temperatura medie a celulei. |
| Temperatura din puț, Lună | Model termic publicat (Horvath și colaboratorii, 2022), construit pe temperaturile măsurate de Diviner. Interiorul peșterii din spatele puțului nu a fost observat. | Se folosește valoarea din articol pentru țintă. |
| Vulcani bazaltici din Holocen | Catalog compilat de Smithsonian din literatura geologică: poziție, tip de vulcan, tip de rocă. | 1. Se păstrează doar vulcanii bazaltici efuzivi (scuturi, câmpuri vulcanice, fisuri). 2. Pentru fiecare celulă se calculează distanța pe sferă până la cel mai apropiat. |
| Puțuri lunare (LROC) | Găsite în imaginile de mare rezoluție ale camerei LROC, prin căutare automată și verificare manuală. | Ținta moștenește tipul de rocă gazdă din catalog. |
| Peșteri candidate pe Marte (Cushing) | Identificate vizual în imagini termice și vizibile din orbită. Adâncimile sunt valori minime. | Ținta moștenește poziția și tipul din catalog. |
| Intrări cunoscute pe Pământ | Listă întreținută manual din literatură. | Celula primește 1 dacă conține un punct din listă. |

**De ce contează**
- Tuburile de lavă se formează doar în curgeri de lavă bazaltică fluidă, de aceea distanța până la bazalt tânăr arată unde pot exista.
- Interiorul unui puț are temperatură stabilă: partea umbrită a puțului din Mare Tranquillitatis stă în jur de +17 °C, în timp ce suprafața variază cu circa 290 K. Asta îl face atractiv ca adăpost.
- Subteranul blochează semnalul radio și GPS, deci acolo se testează navigația autonomă.

**Surse**
- Temperatura din peșteră: MODIS MOD11C3 (Pământ); Horvath, Paige și Hayne 2022 (Lună).
- Bazalt: lista Smithsonian de vulcani din Holocen. Licența permite doar uz necomercial; înlocuitor deschis: baza NOAA NCEI.
- Ținte: catalogul LROC de puțuri lunare; catalogul USGS Cushing de peșteri candidate pe Marte.
- Intrări pe Pământ: nu există set global; listă întreținută manual.

**Ce am folosit și de ce**

| Ce am folosit | De ce asta și nu altceva |
|---|---|
| Distanța până la bazalt tânăr | Nu există o hartă globală a tuburilor de lavă. Tuburile se formează doar în lavă bazaltică fluidă, deci vulcanii bazaltici recenți arată unde e plauzibil să existe. |
| Doar vulcani din Holocen | Tuburile vechi sunt de regulă prăbușite sau umplute; cele tinere sunt încă accesibile. |
| Temperatura medie de la suprafață pentru peșteri | Roca amortizează variațiile, iar interiorul unei peșteri se așază aproape de media anuală de deasupra. Măsurători în peșteri există doar pentru câteva locuri. |
| Listă manuală de intrări cunoscute | Singura sursă sigură: peșterile folosite deja ca analogi sunt documentate în literatură, nu într-un set de date. |
| Cataloagele LROC și Cushing pentru ținte | Sunt cataloagele oficiale ale puțurilor lunare și ale peșterilor candidate de pe Marte, în domeniu public. |

**Limite**
- Tuburile de lavă terestre nu sunt sterile: în tubul Corona din Lanzarote s-au găsit comunități microbiene.
- Temperatura peșterii pe Pământ e o aproximare din temperatura de la suprafață, nu o măsurătoare în peșteră.

---

## Ce nu este criteriu

Acestea apar pe cardul țintei, la „unde analogia se rupe”, sau ca mici calculatoare:

| Element | Formulă | De ce nu e criteriu |
|---|---|---|
| Gravitație | descărcare necesară `= 1 − g_țintă / g_Pământ`: 83,5% pentru Lună, 62,2% pentru Marte | e constantă pe corp, nu diferă de la un loc la altul |
| Lungimea umbrei | `L = h / tan(e)` | depinde de obstacol, nu de celulă |
| Unghi de răsturnare | `arctan( ecartament / (2 × înălțimea centrului de greutate) )` | e o proprietate a roverului |
| Deformare termică | `ε = α × ΔT` | depinde de material |
| Ecranare la radiații | fără formulă simplă validă | pe Pământ atmosfera ecranează oricum; rămâne doar „subteran: da/nu” |

---

## Surse și licențe

| Sursă | Folosită pentru | Licență |
|---|---|---|
| LOLA, Diviner, MOLA, cataloage LROC și USGS (arhiva NASA PDS) | Relief, temperatură, subteran | Domeniu public, cu citare |
| MODIS (MOD11, MOD13, MCD43, MOD17), GPM IMERG, MERRA-2, SMAP | Temperatură, vegetație, albedo, precipitații, praf, umiditate | Date NASA deschise (CC0), citare recomandată |
| ETOPO (NOAA) | Relief pe Pământ | Domeniu public |
| Copernicus GLO-30/90, Sentinel-2 | Relief fin, indici minerali | Acces liber, cu mențiunea Copernicus |
| MACDA v2.0 (CEDA) | Temperatură și vânt pe Marte | Open Government Licence v3, citare obligatorie |
| Cataloagele de cratere Robbins (USGS) | Cratere pe Lună și Marte | Produse USGS, în mod normal domeniu public; de confirmat |
| Earth Impact Database | Cratere de impact pe Pământ | Nicio licență afișată: se publică doar distanțe derivate, cu citare |
| Montabone, opacitatea prafului pe Marte | Praf pe Marte | CC BY-SA 3.0: fișierul derivat se publică separat, cu aceeași licență |
| SoilGrids 2.0, ERA5-Land | Viață microbiană | CC BY 4.0 |
| Global Aridity Index v3.1 | Viață microbiană | CC BY 4.0, descris și ca „uz necomercial”; de clarificat |
| SWIM | Gheață în subsol pe Marte | Nicio licență afișată; se citează articolele |
| Smithsonian, vulcani din Holocen | Distanța până la bazalt | Doar uz necomercial; de înlocuit cu NOAA NCEI |

**Surse scoase din plan**: Mars Climate Database (nu acordă explicit dreptul de a publica valori derivate)
și WorldClim (redistribuire interzisă).

---

## De verificat înainte de implementare

- Coordonatele țintelor Jezero, Gale, Meridiani, Arcadia și Deuteronilus.
- Sursa de albedo pentru Lună și Marte.
- Pragurile pentru umiditatea solului și pentru cei doi indici minerali.
- Acoperirea NDVI și a datelor de sol în Antarctica.
- Pașii de prelucrare pentru criteriile noi sunt planul de lucru, nu cod existent; se pot schimba la implementare.
- De confirmat dacă Global Aridity Index e derivat din WorldClim (a cărui redistribuire e interzisă) și ce înseamnă asta pentru valorile derivate.
- Mai multe cifre din cercetare vin din rezumate, nu din sursa citită direct; se verifică înainte să apară în site.
