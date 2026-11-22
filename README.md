# Request Scheduler

Egy kis Node.js szolgáltatás, ami a `jobs.json`-ban megadott időpontokban HTTP kéréseket vagy **kéréssorozatokat** küld előre rögzített paraméterekkel. Nincs külső függőség, `npm install` sem kell. Node 18 vagy újabb szükséges.

## Indítás

```bat
start.cmd                      :: indítás a jobs.json-nal
start.cmd jobs.json --list     :: jobok és a következő 3 futásuk
start.cmd jobs.json --check    :: csak a konfiguráció ellenőrzése
start.cmd jobs.json --run demo-percenkent   :: egy job azonnali futtatása, majd kilépés
```

A `start.cmd` a PATH-on lévő `node`-ot használja, ha nincs, akkor az IntelliJ beépítettjét. Közvetlenül is futtatható: `node src/index.js jobs.json`.

Futás közben:
- **a `jobs.json` mentésekor automatikusan újratölt**. Ha a fájl hibás, kiírja a hibát, és a régi beállítás marad érvényben;
- a napló a konzolra és a `logs/ÉÉÉÉ-HH-NN.log` fájlba megy;
- ha a `server.port` meg van adva: `GET http://127.0.0.1:3030/` mutatja az állapotot, `POST /run/<job neve>` kézzel indít egy jobot;
- leállítás: **Ctrl+C**.

## A `jobs.json` felépítése

```jsonc
{
  "server":    { "port": 3030 },                 // opcionális státusz-felület (csak localhost)
  "defaults":  { "timeout": "30s", "retries": 2, "retryDelay": "10s",
                 "logResponseBody": 300,          // a válaszból ennyi karaktert naplóz (0 = semmit)
                 "headers": { "User-Agent": "..." } },
  "variables": { "baseUrl": "https://api.pelda.hu" },
  "jobs": [ { ... } ]
}
```

### Egy job

| Mező | Jelentés |
|---|---|
| `name` | egyedi név (kötelező) |
| `schedule` | mikor fusson, lásd lent (kötelező) |
| `requests` | a kérések, **sorban** futnak (kötelező) |
| `enabled` | `false` → kikapcsolva |
| `runOnStart` | `true` → indításkor azonnal lefut egyszer |
| `stopOnError` | alapból `true`: hibás lépés után a sorozat megáll |
| `variables`, `headers`, `timeout`, `retries`, `retryDelay` | a `defaults` felülírása erre a jobra |
| `allowOverlap` | `true` → akkor is indul, ha az előző futás még tart (alapból kimarad) |

### Ütemezés (pontosan egy kell belőle)

```jsonc
{ "at": "2026-11-21 09:00" }                          // egyszer (vagy tömb: több fix időpont)
{ "every": "15m" }                                    // időközönként: 30s, 15m, 1h30m, 1d
{ "daily": ["08:00", "17:30"], "days": ["mon", "fri"] }  // napi időpontok, opcionálisan adott napokon (magyarul is: hét, ked, sze, csü, pén, szo, vas)
{ "cron": "*/10 8-17 * * mon-fri" }                   // cron: perc óra nap hónap hét-napja
```

Minden időpont a gép helyi ideje szerint értendő. Ha a gép aludt, és lekésett egy időpontot, felébredéskor egyszer lefut, és utána a normál ütemezés szerint folytatja. Az óraátállítás éjjelén a nem létező időpont (pl. 02:30) kimarad.

### Egy kérés

```jsonc
{
  "name": "login",                       // opcionális; erre lehet hivatkozni: {{responses.login...}}
  "method": "POST",                      // alapból GET, ha van body/form, akkor POST
  "url": "{{baseUrl}}/auth",
  "query": { "lang": "hu" },             // ?lang=hu
  "headers": { "X-Api-Key": "{{env.API_KEY}}" },
  "body": { "user": "viktor" },          // objektum → JSON; string → nyersen megy
  "form": { "a": "1" },                  // VAGY űrlap (x-www-form-urlencoded)
  "expectStatus": [200, 201],            // alapból bármely 2xx; "4xx" alak is jó
  "save": { "token": "body.access_token" },  // érték mentése a válaszból a következő lépésekhez
  "delayAfter": "2s",                    // várakozás a következő lépés előtt
  "timeout": "10s", "retries": 3, "retryDelay": "5s"
}
```

### Változók: `{{...}}`

- `variables` (globális és job-szintű) és a `save`-vel mentett értékek: `{{token}}`
- korábbi válaszok: `{{responses.login.body.user.id}}`, `{{last.status}}`, `{{last.headers.location}}`
- környezeti változók: `{{env.API_JELSZO}}`. **A jelszavakat így add meg, ne írd bele a fájlba.**
- beépítettek: `{{now}}` (ISO idő), `{{date}}`, `{{time}}`, `{{timestamp}}` (ms), `{{unix}}` (mp), `{{uuid}}`

Ha egy mező értéke egyetlen helyőrző (`"id": "{{uid}}"`), a típusa megmarad (szám marad szám). Az ismeretlen változókra figyelmeztet a napló.

## Tervszimulátor (`--plan`)

Egy időzített terv (pl. `examples/terv.example.json`) minden indítását **ezredmásodperc-pontosan** lejátssza. Az indítás pillanatában a program naplóz („itt ment volna ki”), és kérésre Windows-értesítést küld. **Semmit nem küld ki semmilyen rendszernek.**

```bat
start.cmd --plan tervek\terv.json --check           :: ellenőrzés + menetrend
start.cmd --plan tervek\terv.json --html            :: indítópult: tervek\terv.html (böngészőben megnyitható)
start.cmd --plan tervek\terv.json --villages        :: a terv játékosának falvai (nyilvános világadatokból)
start.cmd --plan tervek\terv.json --villages valaki :: más játékos falvai
start.cmd --plan tervek\terv.json                   :: valós idejű lejátszás a terv időpontjaiban
start.cmd --plan tervek\terv.json --notify          :: ugyanez Windows-értesítéssel
start.cmd --plan tervek\terv.json --shift 10s --speed 600   :: próba: 10 mp múlva indul, 600× gyorsítva
```

| Kapcsoló | Jelentés |
|---|---|
| `--check` | csak ellenőrzés |
| `--shift 10s` | az egész tervet eltolja, hogy az első indítás ennyi idő múlva legyen |
| `--speed 600` | gyorsítás (a pontosságot valós ms-ban méri) |
| `--warn 2m,15s` | előfigyelmeztetések (alapból 2m,15s; `none` = nincs) |
| `--notify` | Windows-értesítés figyelmeztetéskor és indításkor |
| `--offline` | ne töltse le a világadatokat (a terv feltevéseivel számol) |
| `--refresh` | a világadatok újratöltése az egyórás gyorsítótár ellenére |

**Ellenőrzés:** a világ nyilvános adataiból (falvak, játékosok, egységsebesség, éjszakai bónusz) újraszámolja a menetidőket. Ha egy parancs a kerekítés miatt egy másodperccel később érkezne, kiírja a helyes indítási időt. Megnézi a falvak tulajdonosát és azonosítóját, azt, hogy egy célpontra minden parancs ugyanabban a másodpercben érkezik-e, és hogy a nukeok a nemesek előtt érnek-e oda. A nyilvános adatokat óránként legfeljebb egyszer tölti le, a `cache/` mappába. Ezekhez nem kell bejelentkezni, és bejelentkezést a program nem is végez.

**Pontos időzítés (`src/plan/precise.js`):** a `setTimeout` Windowson akár ~15 ms-ot is késhet. Ezért a program a cél előtt 30 ms-mal „felébred”, és onnan `setImmediate`-tel, a monoton `performance.now()` órát figyelve várja ki a célpillanatot. Mért eredmény: 0,0–0,7 ms eltérés, egy vonat egymás utáni részei között kb. 0,2 ms.

**Indítópult (`--html`):** egyetlen önálló HTML-fájl, szerver nélkül megnyitható. Élő órát mutat ms-pontossággal, parancsonként visszaszámlál, és 2 perccel, illetve 15 másodperccel az indítás előtt hanggal és villogó címmel figyelmeztet. A „Megnyitás” gomb a megfelelő falu Gyülekezőhelyét nyitja meg a célkoordinátákkal. A „Kiment” pipa állapota a böngészőben marad meg. Az óra-eltérés a játék szerveridejéhez igazítható. Az oldal semmit nem küld.

**Riport:** minden futás végén a `logs/terv-<időpont>.json` fájlba kerül a tervezett és a tényleges idő és az eltérés statisztikája.

A valódi tervek a `tervek/` mappába valók; ez a mappa nem kerül be a repóba (`.gitignore`).

### Parancsépítők (`--build`)

Az érkezési időből kiszámolják a menetidőt és az indítást, és kész parancsot adnak. A `--into` a tervbe is beírja: sorszámot ad, indítási sorrendbe rendez, előtte ellenőrzi, a régi változatot `.bak`-ként megtartja, végül lefuttatja a teljes ellenőrzést.

```bat
start.cmd --build nuke        --source 525^|558 --target 530^|559 --arrival 2026-11-23T14:13:40.250+01:00 --into tervek\terv.json
start.cmd --build noble_train --source 524^|560 --target 530^|559 --arrival ...  --units "{\"axe\":6700,\"snob\":4,\"light\":2974}" --into tervek\terv.json
start.cmd --build fake        --source ... --target ... --arrival ... --units "{\"unit\":\"ram\",\"count\":1}"
start.cmd --build quad        --source ... --target ... --arrival ... --units "{\"axe\":100,\"ram\":10}"
```

| Építő | Mit ad |
|---|---|
| `nuke` | **minden otthoni egység** (`"send_all": true`): a leglassabb egység (`--slowest`, alapból a `--units` leglassabbja, végül kos) sebességéig megy minden, a nemes és a lovag otthon marad. A `--units` itt csak tájékoztató. `--exact`: pontosan a `--units` megy |
| `noble_train` | 4 rész: teljes sereg − 3 nemes − 300 bárdos, majd 3× (1 nemes + 100 bárdos). A `--units` a falu teljes serege |
| `fake` | 1 (vagy `count`) egység, pontos számmal |
| `quad` | ugyanaz a parancs 4×, 2 mp-es érkezési különbséggel, pontos számokkal (nem „minden egység”, különben az első vinne mindent) |

Sebességek és falunevek: `--server https://hu103.klanhaboru.hu/game.php`, vagy a `--into`/`--plan` terv `server` mezője (nyilvános világadatok; a falu-azonosító és a név is bekerül), különben a terv `assumptions.speed_seconds_per_field` értékei. Időzóna nélküli `--arrival` a gép helyi ideje. `--role nuke_2` a szerepet állítja.

**A terv `send_all` mezője:** a `nuke`, `nuke_1`, `nuke_2`… szerepű parancsok alapból „minden egység” módban vannak (`"send_all": false` kapcsolja ki); vonatnál (`train`) nem érvényes. Az ellenőrzés szól, ha
- egy faluból egy „minden egység” nuke után még indul valami, ami ugyanilyen egységet kér (kivéve, ha az oda-vissza út után indul: akkor csak megjegyzés);
- a „minden egység” nukenak nincs leglassabb egysége, vagy a tervezett egységei közül valami (nemes, lovag, lassabb egység) otthon maradna;
- egy nem „minden egység” parancsban nincs egység, egy nemesvonat-részben nincs nemes, ismeretlen az egység neve, nem egész a szám, vagy kétszer szerepel ugyanaz az `order`.

## Folyamatos futtatás Windowson

- **Kézzel:** `start.cmd`, és nyitva hagyod az ablakot.
- **Bejelentkezéskor automatikusan:** Feladatütemező → *Alapfeladat létrehozása* → Eseményindító: *Amikor bejelentkezem* → Művelet: *Program indítása* → `D:\Viktor\work\RequestScheduler\start.cmd`, „Indítás helye”: `D:\Viktor\work\RequestScheduler`.

## Felépítés

```
src/index.js      parancssor, indítás, fájlfigyelés
src/scheduler.js  időzítők, újratöltés, átfedések kezelése
src/runner.js     egy kéréssorozat lefuttatása (fetch, újrapróbálás, save)
src/schedule.js   at / every / daily / cron ütemezések
src/cron.js       cron-értelmező
src/template.js   {{változó}} behelyettesítés
src/server.js     státusz HTTP-felület
src/config.js     jobs.json ellenőrzés, érthető hibaüzenetekkel
src/plan/cli.js     tervszimulátor: idővonal, eltolás/gyorsítás, visszaszámláló, riport
src/plan/plan.js    terv beolvasása és ellenőrzése (menetidők, sorrend, falvak)
src/plan/precise.js ezredmásodperc-pontos várakozás
src/plan/world.js   a világ nyilvános adatai (village/player/ally.txt, config, unit_info) gyorsítótárral
src/plan/notify.js  Windows-értesítés
src/plan/html.js    önálló HTML indítópult generálása
examples/           kitalált példaterv
```
