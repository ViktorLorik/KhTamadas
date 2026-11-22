# Automata időzített támadás-küldés (új)

Az eddigi HTML-indítópult helyett az alkalmazás **maga küldi ki** a megtervezett támadásokat
a terv időpontjaiban, ms-os pontossággal. Ehhez a tulajdonos kérése szerint nincs szükség
böngészőbővítményre: az alkalmazás a játékkal közvetlenül, HTTP-n kommunikál.

## 1. Munkamenet (egyszeri beállítás)

A játék bejelentkezett munkamenetét egyszer ki kell menteni:

1. Nyisd meg a Klánháborút a böngészőben és jelentkezz be.
2. Nyisd meg a konzolt (F12 → Konzol), írd be: `document.cookie`
3. A visszaadott `nev=ertek; nev2=ertek2; ...` listát másold át a `session.json`-ba
   (a `session.example.json` alapján):
   ```json
   {
     "server": "https://hu103.klanhaboru.hu",
     "cookies": { "sid": "...", "cid": "...", "ssid": "...", "csid": "..." }
   }
   ```
4. Tedd a `session.json`-t a `.gitignore`-ba (sütiket sose commitolj!).

A süti a munkamenet végéig (játék szerinti kijelentkezésig) érvényes; ha lejár,
a program érthető hibaüzenettel áll le, és újra kell menteni.

## 2. Futtatás

```bat
start.cmd --plan tervek\tamadas_terv.json --check                    :: ellenőrzés (mindig ezzel kezdd)
start.cmd --plan tervek\tamadas_terv.json --send session.json      :: ÉLES küldés a terv időpontjaiban
start.cmd --plan tervek\tamadas_terv.json --send session.json --notify
```

- `--send` **csak valós időben** működik: `--shift` és `--speed` tiltott mellé
  (így gyakorláskor véletlenül sem küldhetsz ki valódi támadást).
- `--prepare 5s` (alapértelmezett): ennyivel az indítás előtt tölti le a
  megerősítő űrlapokat, hogy az utolsó, tényleges küldő kérés pont az indítási
  pillanatban induljon. Egy nemesvonat 4 része egymás után, néhány ms-on belül megy ki.
- A küldés a játék saját űrlap-folyamatát használja (Gyülekezőhely → megerősítés →
  indulás), ugyanúgy, mintha a böngészőben nyomnád meg a gombot.

## 3. Parancsépítők (Tampermonkey-gombok helyett)

```bat
:: Nemesvonat: 1. = teljes sereg − 3 nemes − 300 bárdos, 2–4. = 1 nemes + 100 bárdos
start.cmd --build noble_train --source "530|550" --target "508|574" ^
  --arrival 2026-11-21T08:45:01+01:00 --units "{\"axe\":6209,\"snob\":4,\"light\":2734,\"ram\":512}" ^
  --plan tervek\tamadas_terv.json --out tervek\nemesvonat.json

:: Fake (1 bárdos támadásként megy ki)
start.cmd --build fake --source "530|550" --target "508|574" --arrival ... --units "{\"unit\":\"axe\",\"count\":1}" --plan tervek\tamadas_terv.json

:: Gyors 4x: ugyanaz a parancs 4-szer, 2 mp különbséggel
start.cmd --build quad --source "530|550" --target "508|574" --arrival ... --units "{\"axe\":100,\"spy\":1}" --plan tervek\tamadas_terv.json
```

A `--plan` itt csak az egységsebességekhez kell (a világ hivatalos adataiból számolja
a menetidőt). A kész parancsot a terv `commands` tömbjébe kell beilleszteni.

## 4. Hibakezelés

- **„A munkamenet érvénytelen”** → süti lejárt; újra kell menteni a `document.cookie`-t.
- **Botvédelem (reCAPTCHA)** → a játék emberi ellenőrzést kér; oldd meg a böngészőben.
- **error_box a megerősítéskor** → pl. nincs annyi egység a faluban, védett a cél;
  a játék üzenete alapján javítsd a tervet.
- A riport (`logs/terv-*.json`) minden indításról rögzíti: siker/kimaradt/hiba, eltérés ms-ban.

## 5. Fontos tudnivalók

- Az automatikus küldés **a játék szabályai ellenére** megy – kockázat (kitiltás) a
  játékost terheli. Először mindig `--speed 600`-os szimulációval gyakorolj, és
  ellenőrizd a `--check` kimenetét.
- A pontosság változatlan: átlag 0,0–0,7 ms eltérés (lásd a szimulátor riportjait).
