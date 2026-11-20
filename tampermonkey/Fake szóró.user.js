// ==UserScript==
// @name         Fake szóró
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  A screen=place oldalon egy "Fake szóró" gomb: a megadott koordinátalistából csak a 2 kijelölt klán falvait tartja meg, abból kiválaszt 10-et (a régóta nem támadottakat előnyben részesítve), és mindegyikre 1 kos (ha nincs kos, 1 katapult) támadást indít.
// @match        https://*.klanhaboru.hu/game.php*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    if (params.get('screen') !== 'place') return;

    // Az URL-ben lehet "n1920" / "p1920" is (falu-léptetés: következő/előző falu),
    // ezért a valódi azonosítót az oldal game_data-jából vesszük. Csak akkor
    // használjuk az URL-t, ha az tisztán számot tartalmaz.
    function resolveSourceVillage() {
        const gd = window.game_data;
        if (gd && gd.village && gd.village.id) return String(gd.village.id);
        const v = params.get('village') || '';
        return /^\d+$/.test(v) ? v : '';
    }

    const sourceVillage = resolveSourceVillage();
    if (!sourceVillage) return;

    // ---- Beállítások ----

    //MONKEY
    const MONKEY =
    "504|536 507|535 504|534 500|533 504|535 509|537 511|540 504|532 504|531 501|536 511|541 510|537 508|533 508|534 510|542 510|541 503|540 511|535 506|531 510|536 505|536 508|541 507|541 507|531 506|537 507|539 505|540 502|530 505|531 504|541 502|531 505|533 498|533 501|533 501|535 511|538 513|545 514|543 513|544 511|549 516|539 516|541 570|531 573|528 575|513 579|505 567|526 566|526 567|527 573|525 573|534 576|527 573|536 568|527 566|529 567|533 569|534 563|529 562|527 560|530 562|530 574|533 570|524"

    //HONTANA
    const HONTANA =
    "515|548 548|560 516|542 501|550 545|560 552|562 501|540 548|559 500|552 501|538 548|562 505|548 503|543 502|539 544|566 514|554 499|550 545|557 503|545 513|554 505|545 510|544 516|540 513|553 515|532 544|557 503|547 547|565 504|546 501|539 "

    //const KOORDINATAK =
      //  "514|543 513|544 513|545 510|544 511|549 505|548 505|545 504|546 503|547 503|545 503|543 508|541 507|541 507|539 505|540 504|541 503|540 502|539 501|539 501|538 501|540 506|537 511|538 510|537 509|537 511|535 510|536 511|534 508|534 508|533 507|535 505|536 504|536 504|535 504|534 505|533 514|534 513|535 501|536 501|535 501|534 501|533 500|533 507|531 507|530 505|530 506|530 506|531 505|531 504|531 504|532 502|531 502|530 505|529 504|528 501|528 505|527 507|527 512|529 510|528 512|528 505|525 504|524 502|523 501|525 507|525 501|528 514|520 515|520 514|521 513|522 512|519 513|518 515|518 512|517 511|518 519|516 519|515 518|515 518|517 515|515 514|514 512|515 519|511 519|510 520|510 519|513 518|509 511|508 512|507 511|512 514|505 513|505 512|505 510|505 509|505 516|505 516|506 519|505 518|505 518|506 519|506 518|507 519|502 520|502 517|503 522|503 521|505 521|506 523|506 523|512 522|511 522|510 520|510 527|501 526|501 525|501 529|502 528|503 529|499 530|500 528|499 526|498 524|498 533|499 535|502 538|506 543|504 544|504 544|502 544|501 544|503 544|505 543|505 541|504 539|501 542|500 549|502 548|502 557|508 557|507 554|507 554|506 556|505 558|506 568|516 568|517 567|518 565|519 565|520 566|521 574|509 569|506 569|504 569|505 572|504 572|505 571|508 568|527 567|526 567|527 566|526 566|529 570|531 563|529 573|536 573|534 569|534 567|533 573|528 573|525 576|527 ";

    const KOORDINATAK = MONKEY + HONTANA;

    // A klánok, amiknek a falvaira szabad támadni (teljes név és rövidítés is elfogadott).
    const ALLOWED_ALLY_TAGS = ['winter', 'frici'];
    const ALLOWED_ALLY_NAMES = ['-winter is coming-', 'frici pp klán'];

    const TARGET_COUNT = 10;
    const DELAY_BETWEEN_MIN = 200; // ms, két támadás indítása között
    const DELAY_BETWEEN_MAX = 400; // ms

    // Csak ezen az időszakon KÍVÜL landoló támadásokat engedjük (szerveridő szerint).
    const EJSZAKAI_KEZDETE = 23; // óra
    const EJSZAKAI_VEGE = 7; // óra

    // ---- Segédfüggvények (ua. mintázat, mint a többi klánháborús scriptben) ----

    const ALL_UNITS = [
        'spear', 'sword', 'axe', 'archer', 'spy', 'light',
        'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob',
    ];

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const randDelay = () => DELAY_BETWEEN_MIN + Math.random() * (DELAY_BETWEEN_MAX - DELAY_BETWEEN_MIN);

    // Előzmény: "x|y" -> annak a futásnak az időbélyege, amikor utoljára sikeresen ment rá fake.
    // Világonként közös az összes saját falu között.
    const HISTORY_KEY = `fakeSzoro_history_${location.host}`;

    function loadHistory() {
        try {
            return JSON.parse(localStorage.getItem(HISTORY_KEY)) || {};
        } catch (err) {
            return {};
        }
    }

    function saveHistory(history) {
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        } catch (err) {
            console.warn('Fake szóró – előzmény mentése sikertelen:', err);
        }
    }

    async function fetchText(url, fields) {
        const opts = { credentials: 'same-origin' };
        if (fields) {
            opts.method = 'POST';
            opts.body = new URLSearchParams(fields);
        }
        const res = await fetch(url, opts);
        const text = await res.text();
        return { status: res.status, ok: res.ok, text, url: res.url, redirected: res.redirected };
    }

    function parseDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    // A szerver idő (#serverTime / #serverDate) és a kliens gép órája közti eltolás.
    function getServerOffsetMs() {
        const timeEl = document.getElementById('serverTime');
        if (!timeEl) return 0;

        const parts = timeEl.textContent.trim().split(':').map(Number);
        if (parts.length < 3 || parts.some(Number.isNaN)) return 0;
        const [hh, mm, ss, ms = 0] = parts;

        const now = new Date();
        let year = now.getFullYear();
        let month = now.getMonth();
        let day = now.getDate();

        const dateEl = document.getElementById('serverDate');
        if (dateEl) {
            const d = dateEl.textContent.trim().split('/').map(Number); // nap/hónap/év
            if (d.length === 3 && !d.some(Number.isNaN)) {
                day = d[0];
                month = d[1] - 1;
                year = d[2];
            }
        }

        const serverDate = new Date(year, month, day, hh, mm, ss, ms);
        return serverDate.getTime() - now.getTime();
    }

    function isNightHour(date) {
        const h = date.getHours();
        if (EJSZAKAI_KEZDETE > EJSZAKAI_VEGE) {
            return h >= EJSZAKAI_KEZDETE || h < EJSZAKAI_VEGE; // átnyúlik éjfélen
        }
        return h >= EJSZAKAI_KEZDETE && h < EJSZAKAI_VEGE;
    }

    function formatHm(date) {
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    function harvestForm(formEl) {
        const fields = {};
        if (!formEl) return fields;
        formEl.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
            if (el.disabled) return;
            if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
            fields[el.name] = el.value;
        });
        return fields;
    }

    // A játék hiba esetén is 200-at ad, a hibát az oldalba írja.
    // (A #command-data-form NEM jó jelzés: a sima gyülekezőhely-oldalon is van ilyen.)
    function findGameError(html, doc) {
        if (/érvénytelen/i.test(doc.title)) return doc.title;
        const box = doc.querySelector('.error_box, .autoHideBox.error');
        if (box && box.textContent.trim()) return box.textContent.trim();
        const m = html.match(/UI\.ErrorMessage\(\s*(['"])(.*?)\1/);
        if (m) return m[2];
        return null;
    }

    // A h (CSRF) token: elsősorban az űrlap action-jéből, ha ott nincs, akkor
    // rejtett mezőből, a lekért oldal game_data-jából, végül az aktuális ablakéból.
    function findCsrf(confirmForm, confirmText) {
        const action = confirmForm.getAttribute('action') || '';
        const m = action.match(/[?&]h=([^&]+)/);
        if (m) {
            try {
                return decodeURIComponent(m[1]);
            } catch (err) {
                return m[1];
            }
        }
        const hidden = confirmForm.querySelector('input[name="h"]');
        if (hidden && hidden.value) return hidden.value;
        const js = confirmText.match(/"csrf"\s*:\s*"([^"]+)"/);
        if (js) return js[1];
        return (window.game_data && window.game_data.csrf) || '';
    }

    // A végső "action=command" POST-okat egymás után küldjük - ha két ilyen kérés
    // szinte egyszerre futna be ugyanarra az URL-re, a szerver 405-tel elutasíthatja.
    let commandQueue = Promise.resolve();
    function queueCommand(url, fields) {
        const run = commandQueue.then(() => fetchText(url, fields));
        commandQueue = run.catch(() => {});
        return run;
    }

    // ---- Klán-adatok betöltése (/map/*.txt) ----

    function decodeField(s) {
        try {
            return decodeURIComponent((s || '').replace(/\+/g, ' '));
        } catch (err) {
            return s || '';
        }
    }

    async function fetchMapFile(name) {
        const res = await fetch(`${location.origin}/map/${name}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`${name} letöltése sikertelen (${res.status})`);
        return res.text();
    }

    // Visszaadja: Set("x|y") azokra a falvakra, amik a megadott
    // klánok (tag vagy teljes név) valamelyikéhez tartoznak.
    async function loadAllowedCoordsFromAllies() {
        const [villageTxt, playerTxt, allyTxt] = await Promise.all([
            fetchMapFile('village.txt'),
            fetchMapFile('player.txt'),
            fetchMapFile('ally.txt'),
        ]);

        const wantedTags = new Set(ALLOWED_ALLY_TAGS.map((t) => t.toLowerCase()));
        const wantedNames = new Set(ALLOWED_ALLY_NAMES.map((n) => n.toLowerCase()));

        const allyIds = new Set();
        allyTxt.split('\n').forEach((line) => {
            if (!line.trim()) return;
            const parts = line.split(',');
            const id = parts[0];
            const name = decodeField(parts[1]).toLowerCase();
            const tag = decodeField(parts[2]).toLowerCase();
            if (wantedTags.has(tag) || wantedNames.has(name)) allyIds.add(id);
        });

        const playerAlly = new Map();
        playerTxt.split('\n').forEach((line) => {
            if (!line.trim()) return;
            const parts = line.split(',');
            playerAlly.set(parts[0], parts[2]); // player_id -> ally_id
        });

        const allowedCoords = new Set(); // "x|y"
        villageTxt.split('\n').forEach((line) => {
            if (!line.trim()) return;
            const parts = line.split(','); // id,name,x,y,player_id,points,rank
            const x = parts[2];
            const y = parts[3];
            const playerId = parts[4];
            if (!playerId || playerId === '0') return;
            const allyId = playerAlly.get(playerId);
            if (allyId && allyIds.has(allyId)) {
                allowedCoords.add(`${x}|${y}`);
            }
        });

        return allowedCoords;
    }

    // ---- Támadás indítása egy koordinátára, kos -> katapult fallback-kel ----

    // A ténylegesen elérhető darabszámot az input "data-all-count" attribútuma
    // adja meg - ez megbízható, nem úgy, mint a try=confirm oldal visszhangja,
    // ami a hiányzó egységet is csak simán visszaírja, validáció nélkül.
    function getAvailableCount(placeDoc, unitKey) {
        const input = placeDoc.querySelector(`[name="${unitKey}"]`);
        if (!input) return 0;
        const n = parseInt(input.getAttribute('data-all-count'), 10);
        return Number.isNaN(n) ? 0 : n;
    }

    async function sendOneFake(coords, offsetMs, onStatus) {
        try {
            const placeUrl = `/game.php?village=${sourceVillage}&screen=place`;
            const place = await fetchText(placeUrl);
            const placeDoc = parseDoc(place.text);
            const attackBtn = placeDoc.querySelector('input[name="attack"]');
            const sendForm = attackBtn ? attackBtn.closest('form') : placeDoc.querySelector('form');

            if (!sendForm) {
                onStatus('hiba: nem található a csapatküldő űrlap');
                return false;
            }

            if (getAvailableCount(placeDoc, 'spy') < 1) {
                onStatus('hiba: nincs elérhető kém');
                return false;
            }

            let unitKey;
            let unitUsed;
            if (getAvailableCount(placeDoc, 'ram') >= 1) {
                unitKey = 'ram';
                unitUsed = 'kos';
            } else if (getAvailableCount(placeDoc, 'catapult') >= 1) {
                unitKey = 'catapult';
                unitUsed = 'katapult';
            } else {
                onStatus('hiba: sem kos, sem katapult nem elérhető');
                return false;
            }

            const fields = harvestForm(sendForm);
            ALL_UNITS.forEach((u) => {
                fields[u] = '0';
            });
            fields.spy = '1';
            fields[unitKey] = '1';
            fields.x = coords.x;
            fields.y = coords.y;
            fields.target_type = 'coord';
            fields.source_village = sourceVillage;
            fields.village = sourceVillage;
            fields.input = '';
            fields.attack = 'Támadás';
            fields.template_id = '';

            const confirmUrl = `/game.php?village=${sourceVillage}&screen=place&try=confirm`;
            const confirm = await fetchText(confirmUrl, fields);
            const confirmDoc = parseDoc(confirm.text);
            const confirmForm = confirmDoc.querySelector('#command-data-form');

            if (!confirmForm) {
                console.warn(`Fake szóró – nincs megerősítő űrlap (${unitKey}, ${coords.key}):`, confirm.text);
                onStatus(`hiba: nincs megerősítő űrlap (${unitUsed})`);
                return false;
            }

            let durationSec = null;
            const durationEl = confirmDoc.querySelector('.relative_time[data-duration]');
            if (durationEl) {
                const d = parseInt(durationEl.getAttribute('data-duration'), 10);
                if (!Number.isNaN(d)) durationSec = d;
            }

            if (durationSec != null) {
                const arrival = new Date(Date.now() + offsetMs + durationSec * 1000);
                if (isNightHour(arrival)) {
                    onStatus(`kihagyva: éjszakai bónuszban érne célba (${formatHm(arrival)})`);
                    return false;
                }
            }

            const h = findCsrf(confirmForm, confirm.text);
            if (!h) {
                onStatus(`hiba: nem található a h (csrf) token (${unitUsed})`);
                return false;
            }

            const step2Fields = harvestForm(confirmForm);
            step2Fields.cb = 'troop_confirm_submit';
            step2Fields.submit_confirm = 'Támadás indítása';

            const commandUrl = `/game.php?village=${sourceVillage}&screen=place&action=command&h=${encodeURIComponent(h)}`;
            const result = await queueCommand(commandUrl, step2Fields);

            if (!result.ok) {
                onStatus(`hiba: ${result.status} (${unitUsed})`);
                return false;
            }

            const resultDoc = parseDoc(result.text);
            const gameError = findGameError(result.text, resultDoc);
            if (gameError) {
                console.warn(`Fake szóró – elutasítva (${unitUsed}, ${coords.key}):`, gameError);
                onStatus(`hiba: ${gameError} (${unitUsed})`);
                return false;
            }

            // A sikeres parancs átirányít a gyülekezőhelyre; ha nem történt átirányítás, nem ment ki.
            if (!result.redirected) {
                console.warn(`Fake szóró – nem történt átirányítás (${unitUsed}, ${coords.key}):`, resultDoc.title);
                onStatus(`hiba: a parancsot nem fogadta el a szerver (${unitUsed})`);
                return false;
            }

            onStatus(`elküldve (${unitUsed})`);
            return true;
        } catch (err) {
            console.error('Fake szóró hiba:', err);
            onStatus('hiba: ' + err.message);
            return false;
        }
    }

    // ---- Célpont-választás ----

    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    // Keverés, majd stabil rendezés: a soha/régen használt falvak kerülnek előre,
    // az egyformán régiek között megmarad a véletlen sorrend.
    function pickTargets(eligible, count, history) {
        return shuffle(eligible)
            .sort((a, b) => (history[a.key] || 0) - (history[b.key] || 0))
            .slice(0, count);
    }

    function parseCoordList(raw) {
        return raw
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map((s) => {
                const m = s.match(/^(\d+)\|(\d+)$/);
                return m ? { x: m[1], y: m[2], key: s } : null;
            })
            .filter(Boolean);
    }

    // ---- UI ----

    async function runFakeSpread(btn, panel) {
        btn.disabled = true;
        panel.innerHTML = '';

        const finish = () => {
            btn.textContent = 'Fake szóró';
            btn.disabled = false;
        };

        const addLine = (text) => {
            const line = document.createElement('div');
            line.textContent = text;
            panel.appendChild(line);
            return line;
        };

        const summaryLine = addLine('klán-adatok lekérése…');

        let allowedCoords;
        try {
            allowedCoords = await loadAllowedCoordsFromAllies();
        } catch (err) {
            console.error('Fake szóró – map adatok hiba:', err);
            summaryLine.textContent = 'hiba a klán-adatok lekérésekor: ' + err.message;
            finish();
            return;
        }

        const allCoords = parseCoordList(KOORDINATAK);
        const seen = new Set();
        const eligible = allCoords.filter((c) => allowedCoords.has(c.key) && !seen.has(c.key) && seen.add(c.key));

        if (eligible.length === 0) {
            summaryLine.textContent = 'nincs találat: egyik koordináta sem a megadott 2 klánhoz tartozik';
            finish();
            return;
        }

        const history = loadHistory();
        const runStamp = Date.now();
        const picked = pickTargets(eligible, TARGET_COUNT, history);
        summaryLine.textContent = `${eligible.length} találat a listából, ${picked.length} célpont kiválasztva`;

        const offsetMs = getServerOffsetMs();
        const lines = picked.map((c) => addLine(`${c.key}: indítás…`));

        let okCount = 0;
        for (let i = 0; i < picked.length; i++) {
            if (i > 0) await sleep(randDelay());
            const ok = await sendOneFake(picked[i], offsetMs, (msg) => {
                lines[i].textContent = `${picked[i].key}: ${msg}`;
            });
            if (ok) {
                okCount++;
                history[picked[i].key] = runStamp;
                saveHistory(history);
            }
        }

        summaryLine.textContent = `Kész: ${okCount}/${picked.length} sikeres (${eligible.length} jogosult célpontból választva)`;
        finish();
    }

    function addUi() {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = [
            'position:fixed', 'top:10px', 'right:10px', 'z-index:99999',
            'background:#fdf6e3', 'border:2px solid #7d510f', 'border-radius:4px',
            'padding:8px', 'font-size:12px', 'max-width:260px',
        ].join(';');

        const btn = document.createElement('button');
        btn.textContent = 'Fake szóró';
        btn.style.cssText = [
            'width:100%', 'padding:8px', 'cursor:pointer', 'background:#f4e4bc',
            'border:2px solid #7d510f', 'border-radius:4px', 'font-size:13px',
        ].join(';');
        wrapper.appendChild(btn);

        const panel = document.createElement('div');
        panel.style.cssText = 'margin-top:6px;display:flex;flex-direction:column;gap:2px;max-height:300px;overflow-y:auto;';
        wrapper.appendChild(panel);

        btn.addEventListener('click', () => {
            btn.textContent = 'Fut…';
            runFakeSpread(btn, panel);
        });

        document.body.appendChild(wrapper);
    }

    addUi();
})();