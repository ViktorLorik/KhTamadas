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
```
