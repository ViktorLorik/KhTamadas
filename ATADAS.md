# Átadás – RequestScheduler projekt-kontextus

Ez a dokumentum egy másik fejlesztőnek vagy AI-modellnek írja le a projektet: mi van benne, hogyan épül fel, és hol mi található. A tényleges feladatot a végén, a **Feladat** szakaszban kell megfogalmazni.

## Röviden

- **Mi ez:** Node.js-alkalmazás, két móddal:
  1. **Időzítő:** a `jobs.json`-ban megadott időpontokban HTTP-kéréseket vagy kéréssorozatokat küld.
  2. **Tervszimulátor (`--plan`):** egy támadási terv (JSON) indításait ezredmásodperc-pontosan lejátssza. Az indítás pillanatában jelenleg csak naplóz, értesít és riportot ír.
- **Környezet:** Windows 11, Node 26 (az IntelliJ beépített Node-ja: `%APPDATA%\JetBrains\IntelliJIdea2026.3\node\versions\26.13.1\node.exe`; a `start.cmd` megtalálja). ESM-modulok (`"type": "module"`), **nincs külső npm-függőség**, és az eddigi kód ezt meg is tartja.
- **Nyelv:** a naplóüzenetek, a hibaüzenetek és a megjegyzések magyarul vannak, az azonosítók angolul.
- **Git:** `main` ág, távoli tároló nincs. A tulajdonos szabálya: **commit, push és merge csak az ő kifejezett jóváhagyásával.**

## Futtatás

```bat
start.cmd                                        :: időzítő a jobs.json-nal
start.cmd --plan tervek\tamadas_terv.json --check    :: terv ellenőrzése + menetrend
start.cmd --plan tervek\tamadas_terv.json --shift 5s --speed 600   :: gyorsított próba
start.cmd --plan tervek\tamadas_terv.json        :: valós idejű lejátszás
start.cmd --plan tervek\tamadas_terv.json --html     :: HTML indítópult generálása
start.cmd --plan tervek\tamadas_terv.json --villages :: falulista a nyilvános világadatokból
```

## Fájlszerkezet

```
src/index.js        belépési pont; ha a parancssorban van --plan, a src/plan/cli.js-nek adja át
src/scheduler.js    időzítő mód: setTimeout-alapú ütemezés, újratöltés, átfedés-védelem
src/runner.js       időzítő mód: egy kéréssorozat végrehajtása (fetch, újrapróbálás, "save" változók)
src/schedule.js     at / every / daily / cron ütemezés
src/cron.js         cron-értelmező
src/template.js     {{változó}} behelyettesítés
src/config.js       jobs.json ellenőrzése
src/server.js       státusz HTTP-felület (GET /, POST /run/<név>)
src/logger.js       színes konzol + napi naplófájl (logs/)
src/util.js         időtartam, dátumformázás, getPath stb.

src/plan/cli.js     tervszimulátor: argumentumok, idővonal (eltolás/gyorsítás), eseményciklus, riport
src/plan/plan.js    terv beolvasása (loadPlan) és ellenőrzése (checkPlan): menetidő, sorrend, falvak
src/plan/precise.js ms-pontos várakozás: createClock(), waitUntil(target, { clock, onTick })
src/plan/world.js   a világ nyilvános adatai (map/village.txt, player.txt, ally.txt,
                    interface.php?func=get_config / get_unit_info), 1 órás gyorsítótár: cache/<világ>/
src/plan/html.js    önálló HTML indítópult generálása
src/plan/notify.js  Windows-értesítés PowerShellből

examples/terv.example.json   kitalált példaterv
tervek/                      valódi tervek (gitignore)
cache/, logs/, tampermonkey/ gitignore
```

## A terv formátuma (bemenet)

```jsonc
{
  "plan": "név", "server": "https://hu103.klanhaboru.hu/game.php", "world": "hu103",
  "player": "saját játékosnév", "enemy": "ellenfél",
  "assumptions": { "speed_seconds_per_field": { "ram": 1666.667, "snob": 1944.444 }, "night_bonus": "23:00–07:00" },
  "targets": [ { "key": "A", "coord": "507|574", "name": null, "id": null } ],
  "commands": [
    {
      "order": 1, "role": "nuke_1" | "noble_train" | "catapult_train" | ...,
      "source": { "name": "302 Popo", "id": 2804, "coord": "530|550" },
      "target": { "coord": "508|574", "name": null, "id": null },
      "units": { "axe": 6209, "spy": 100, "light": 2734, "ram": 512 },     // VAGY:
      "train": [ { "noble": 1, "units": { ... } }, { "noble": 2, "units": { ... } } ],
      "slowest_unit": "ram", "travel_seconds": 54262,
      "arrival": "2026-11-21T08:45:01.100+01:00",
      "launch":  "2026-11-20T17:40:39.100+01:00",
      "catapult_target": "TBD"
    }
  ]
}
```

## Belső adatmodell (`loadPlan` kimenete)

```js
plan = { meta /* az eredeti JSON */, commands: [c, ...] }   // indítás szerint rendezve

c = {
  order, role, roleName,
  source: { name, id, coord, pos: { x, y } },
  target: { coord, name, id, pos, label /* targets[].key */, world /* a világ falu-objektuma, ha be van töltve */ },
  slowest, travelSeconds,
  launch, arrival,            // epoch ms
  catapultTarget, note,
  parts: [ { index /* 1.. */, label, units: { axe: 100, snob: 1, ... } } ]   // sima parancsnál 1 elem
}

// world (src/plan/world.js): { world, server, speed, unitSpeed, night, secondsPerField,
//   villages: Map<id, {id,name,x,y,coord,owner,points}>, players, villageAt(coord), player(name), villagesOf(player) }
```

## Az eseményciklus (`src/plan/cli.js`, a `main()` vége)

- Az események: minden parancshoz előfigyelmeztetések (`kind: 'warn'`), és minden vonatrészhez egy-egy indítás (`kind: 'launch'`). Idő szerint vannak rendezve, és egy `for … of` ciklus dolgozza fel őket **sorban, `await`-tel**.
- `waitUntil(realTarget, { clock, onTick })` (177. sor) ms pontossággal kivárja a célidőt: durva `setTimeout`, utána `setImmediate`-es pörgés a `performance.now()`-ra. Mért eltérés: 0,0–0,7 ms.
- `toReal` / `toVirtual`: a terv szerinti időt alakítja valós időre és vissza (`--shift` / `--speed`). Normál módban mindkettő az identitás.
- **Az indítás pillanata a 191–202. sorban van.** Itt a következők érhetők el:
  - `c`: a parancs (lásd fent), `p`: az aktuális vonatrész (`p.index`, `p.units`),
  - `e.at`: a tervezett idő (ms), `deviation`: a várakozás eltérése (ms),
  - jelenleg: `log.ok('… ITT MENT VOLNA KI')`, opcionálisan `notify(...)`, és egy bejegyzés a `results` tömbbe (ebből készül a riport: `logs/terv-<időbélyeg>.json`).
- Egy vonat részei ugyanazzal az `e.at`-tal, közvetlenül egymás után kerülnek sorra. Ha itt egy lépés hosszabb ideig `await`-el, az eltolja a következő esemény kezdését.

## Feladat – a tulajdonos kérései (összefoglaló)

A tulajdonos kérései időrendben, a saját megfogalmazása alapján. Mellette jelölve, mi készült már el.

1. **Alkalmazásszerver, ami előre meghatározott időpontokban kéréseket küld** előre rögzített paraméterekkel, egy JSON-fájl alapján. Elindítja, és az alkalmazás elküldi a kérést vagy kéréssorozatot. – *Kész (időzítő mód).*
2. **A Tampermonkey-szkriptek „egy szinttel feljebb léptetése”:** a böngészőben, gombnyomásra futó Klánháború-szkriptjeit (farm asszisztens, Fake szóró, Térkép Fake gomb, Gyors 4x támadás, Nemesvonat, Időzített támadás indítás) szeretné az időzítő alkalmazásba vinni. – *Nem készült el.*
3. **A támadási terv végrehajtása:** a `tervek/tamadas_terv.json` (hu103 világ, 12 parancs, nukeok, nemesvonatok, katapultvonatok, ms-re megadott indítási és érkezési időkkel) – „ezt kell végrehajtania az alkalmazásnak”. – *Csak a szimuláció készült el: az indítás pillanatában naplóz („itt ment volna ki”), de nem küld.*
4. **Önálló alkalmazás legyen, soha ne böngészőbővítmény.** – *Teljesül.*
5. **A saját falvai adatainak lekérése a játékból**, köztük a **valós csapatadatoké a fiókjából**. – *Részben: a nyilvános világadatokból (falvak, tulajdonosok, pontok, egységsebesség) elkészült; a fiókhoz kötött csapatadatok nem.*
6. **Tudjon legalább annyit, mint a mostani Tampermonkey-gombjai**, például a **Nemesvonat**: 4 támadás egymás után a lehető leggyorsabban. Az 1. a teljes sereg mínusz 3 nemes és 300 bárdos, a maradék 3 egyenként 1 nemes és 100 bárdos, és az első mindig elsőként megy ki. – *Nem készült el.*
7. **Egy alapalkalmazás egy gombbal**, amit ő maga nyom meg. – *Helyette egy HTML indítópult készült (`--html`), ami a megfelelő pillanatban a megfelelő Gyülekezőhely-oldalra visz; a küldés a böngészőben történik.*
8. **Összegezve:** „Egy olyan Node.js-alkalmazást, ami a megtervezett támadásokat automatikusan kiküldi.” A projektben a helye az eseményciklus indítási pontja (`src/plan/cli.js`, 191–202. sor, lásd fent). – *Nem készült el.*
