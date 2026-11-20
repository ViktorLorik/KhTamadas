// ==UserScript==
// @name         Időzített támadás indítás (place)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  A csapatküldő (screen=place) oldalon megadhatod, mikorra érjen oda a támadás - a script kiszámolja a menetidőből a pontos indítási pillanatot, és akkor automatikusan elküldi a már beállított csapatokat/célpontot.
// @match        https://*.klanhaboru.hu/game.php*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    if (params.get('screen') !== 'place') return;

    const sourceVillage = params.get('village');
    if (!sourceVillage) return;

    // Közvetlenül a kilövés előtt ennyivel korábban kérünk friss megerősítést
    // (friss ch/h tokenek miatt). Legyen bőven elég tartalék, hogy a frissítés
    // (most már csak 1 hálózati kör) biztosan befejeződjön a célidő előtt.
    const REFRESH_BEFORE_MS = 3000;
    // Hosszú várakozásnál ennyi mp-enként nézzük újra, közeledik-e az idő
    // (hogy ne egyetlen nagyon hosszú setTimeout fusson, ami háttérben pontatlanabb lehet).
    const POLL_INTERVAL_MS = 15000;

    // Tapasztalat alapján mindig alkalmazott, fix extra kompenzáció (ms) - ez a
    // felületen NEM jelenik meg, a felületi "Extra kompenzáció" mezőhöz adódik hozzá.
    const FIXED_COMPENSATION_MS = 900;

    function getSendForm() {
        const attackBtn = document.querySelector('input[name="attack"]');
        return attackBtn ? attackBtn.closest('form') : document.querySelector('form');
    }

    async function fetchText(url, fields) {
        const opts = { credentials: 'same-origin' };
        if (fields) {
            opts.method = 'POST';
            opts.body = new URLSearchParams(fields);
        }
        const res = await fetch(url, opts);
        const text = await res.text();
        return { status: res.status, ok: res.ok, text };
    }

    function parseDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    // Tiszta hálózati ping becslése: egy könnyű HEAD kérés oda-vissza ideje,
    // nem terhelve a try=confirm oldal szerveroldali renderelési idejével.
    async function measurePingMs() {
        const t0 = performance.now();
        try {
            await fetch(`${location.origin}/favicon.ico?_=${Date.now()}`, {
                method: 'HEAD',
                cache: 'no-store',
                credentials: 'omit',
            });
        } catch (err) {
            // Ha a favicon nem kérhető le, legalább a megkísérelt idő is ad egy becslést.
        }
        return performance.now() - t0;
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

    // A JELENLEG az oldalon beállított csapatok/célpont kiolvasása (nem nyúl hozzájuk).
    function getFormFields() {
        const form = getSendForm();
        return form ? harvestForm(form) : null;
    }

    // Az előnézet (try=confirm) lekérése MÁR MEGLÉVŐ mezőkkel - nem tölti le
    // újra a "place" oldalt, így csak 1 hálózati kör, nem 2. Ezt hívjuk
    // közvetlenül indítás előtt, hogy minél kevesebb idő menjen el friss
    // ch/h token szerzésére (ez okozta korábban a konzisztens ~700-900 ms késést:
    // mire a 2 kérés lefutott, már túl voltunk a célidőn, és a worker azonnal,
    // de későn sütötte el a kérést).
    async function getConfirmWithFields(fields) {
        const confirmUrl = `/game.php?village=${sourceVillage}&screen=place&try=confirm`;
        const confirm = await fetchText(confirmUrl, fields);
        const confirmDoc = parseDoc(confirm.text);
        const confirmForm = confirmDoc.querySelector('#command-data-form');

        if (!confirmForm) {
            console.warn('Időzített támadás – nincs megerősítő űrlap:', confirm.text);
            return null;
        }

        let durationSec = null;
        const durationEl = confirmDoc.querySelector('.relative_time[data-duration]');
        if (durationEl) {
            const d = parseInt(durationEl.getAttribute('data-duration'), 10);
            if (!Number.isNaN(d)) durationSec = d;
        }

        return { confirmForm, durationSec };
    }

    // Kényelmi wrapper: mezők kiolvasása + előnézet lekérése egyben (a kezdeti,
    // nem időkritikus menetidő-becsléshez használjuk).
    async function getConfirm() {
        const fields = getFormFields();
        if (!fields) return null;
        return getConfirmWithFields(fields);
    }

    // Nem időzített (azonnali) küldéshez, ha valaha kellene.
    async function submitConfirm(confirmForm) {
        const { url, fields } = buildCommandRequest(confirmForm);
        return fetchText(url, fields);
    }

    // A szerver idő (#serverTime / #serverDate) és a kliens gép órája közti eltolás.
    // serverNow() = new Date(Date.now() + offset); a setTimeout-okhoz pedig
    // a szerveridőben számolt pillanatból vissza kell vonni az offsetet.
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

    // A pontos várakozást ÉS a tényleges kérés elküldését egy Web Workerben végezzük.
    // Ha több azonos origin-ű fülön is fut ez a script egyszerre, a böngésző
    // könnyen ugyanabba a renderelő folyamatba (és ezáltal ugyanarra a fő szálra)
    // teheti őket - egy főszálon futó szoros "pörgő" várakozás ilyenkor blokkolná
    // a TÖBBI fület is, ami pont a célzott pillanatban okoz egyre növekvő csúszást.
    // A Worker viszont külön szálon fut, így ez nem fordulhat elő.
    const WORKER_SOURCE = `
        function preciseWaitWorker(targetMs) {
            return new Promise((resolve) => {
                function loop() {
                    const remaining = targetMs - Date.now();
                    if (remaining <= 0) { resolve(); return; }
                    if (remaining > 25) {
                        setTimeout(loop, Math.min(remaining - 15, 15000));
                        return;
                    }
                    const targetPerf = performance.now() + remaining;
                    while (performance.now() < targetPerf) { /* szoros várakozás */ }
                    resolve();
                }
                loop();
            });
        }

        self.onmessage = async (e) => {
            const { id, targetMs, url, fields } = e.data;
            await preciseWaitWorker(targetMs);
            const fireTs = Date.now();
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    credentials: 'same-origin',
                    body: new URLSearchParams(fields),
                });
                self.postMessage({ id, ok: res.ok, status: res.status, fireTs });
            } catch (err) {
                self.postMessage({ id, ok: false, error: String(err), fireTs });
            }
        };
    `;

    let worker = null;
    function getWorker() {
        if (!worker) {
            const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
            worker = new Worker(URL.createObjectURL(blob));
        }
        return worker;
    }

    let msgId = 0;
    function fireViaWorker(targetMs, url, fields) {
        return new Promise((resolve) => {
            const w = getWorker();
            const id = ++msgId;
            function handler(e) {
                if (e.data.id !== id) return;
                w.removeEventListener('message', handler);
                resolve(e.data);
            }
            w.addEventListener('message', handler);
            w.postMessage({ id, targetMs, url, fields });
        });
    }

    // Az action=command kéréshez szükséges URL + mezők összeállítása a
    // megerősítő űrlapból (ezt a fő szálon kell csinálni, a Worker nem fér a DOM-hoz).
    function buildCommandRequest(confirmForm) {
        const action = confirmForm.getAttribute('action') || '';
        const hMatch = action.match(/[?&]h=([^&]+)/);
        const h = hMatch ? hMatch[1] : '';

        const fields = harvestForm(confirmForm);
        fields.cb = 'troop_confirm_submit';
        fields.submit_confirm = 'Támadás indítása';

        // Abszolút URL kell, mert a Worker egy blob: URL-ről fut, ahol a relatív
        // útvonal feloldása nem megbízható.
        const url = `${location.origin}/game.php?village=${sourceVillage}&screen=place&action=command&h=${encodeURIComponent(h)}`;
        return { url, fields };
    }

    function serverNow(offsetMs) {
        return new Date(Date.now() + offsetMs);
    }

    // clientEquivalent: egy szerveridőben megadott pillanatot átszámol a kliens
    // gép órájának megfelelő Date-re, hogy setTimeout-tal pontosan arra lőhessünk.
    function toClientTime(serverMoment, offsetMs) {
        return new Date(serverMoment.getTime() - offsetMs);
    }

    // Elfogadja a szerver saját "óó:pp:mm:eee" formátumát (ahogy a #serverTime
    // mutatja), de a másodperc és az ezredmásodperc is elhagyható.
    function parseDesiredTime(value, offsetMs) {
        const m = value.trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,3}))?$/);
        if (!m) return null;

        const hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const ss = m[3] ? parseInt(m[3], 10) : 0;
        // Az ezredmásodperc nullákkal balra kiegészítve (pl. "9" -> 009 ms), nem törtként.
        const ms = m[4] ? parseInt(m[4].padStart(3, '0'), 10) : 0;

        const now = serverNow(offsetMs);
        const target = new Date(now);
        target.setHours(hh, mm, ss, ms);
        if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
        return target; // szerveridőben értendő pillanat
    }

    function fmt(date) {
        return date.toLocaleTimeString('hu-HU', { hour12: false });
    }

    function fmtMs(date) {
        return fmt(date) + '.' + String(date.getMilliseconds()).padStart(3, '0');
    }

    let timer = null;
    let running = false;

    function addUi() {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = [
            'position:fixed', 'top:10px', 'right:10px', 'z-index:99999',
            'background:#fdf6e3', 'border:2px solid #7d510f', 'border-radius:4px',
            'padding:8px', 'font-size:13px', 'max-width:240px',
        ].join(';');

        const label = document.createElement('div');
        label.textContent = 'Kívánt érkezési idő (óó:pp:mm:eee):';
        wrapper.appendChild(label);

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '22:55:00:952';
        input.style.cssText = 'width:100%;margin:4px 0;box-sizing:border-box;';
        wrapper.appendChild(input);

        const extraLabel = document.createElement('div');
        extraLabel.textContent = 'Extra kompenzáció (ms, tapasztalat alapján):';
        wrapper.appendChild(extraLabel);

        const extraInput = document.createElement('input');
        extraInput.type = 'number';
        extraInput.value = '0';
        extraInput.step = '10';
        extraInput.style.cssText = 'width:100%;margin:4px 0;box-sizing:border-box;';
        wrapper.appendChild(extraInput);

        const btn = document.createElement('button');
        btn.textContent = 'Időzített indítás';
        btn.style.cssText = [
            'width:100%', 'padding:6px', 'cursor:pointer', 'background:#f4e4bc',
            'border:2px solid #7d510f', 'border-radius:4px',
        ].join(';');
        wrapper.appendChild(btn);

        const status = document.createElement('div');
        status.style.cssText = 'margin-top:6px;font-style:italic;';
        wrapper.appendChild(status);

        btn.addEventListener('click', () => {
            if (running) {
                cancelSchedule(btn, status);
                return;
            }
            startSchedule(input, extraInput, btn, status);
        });

        document.body.appendChild(wrapper);
    }

    function cancelSchedule(btn, status) {
        if (timer) clearTimeout(timer);
        timer = null;
        running = false;
        btn.textContent = 'Időzített indítás';
        status.textContent = 'ütemezés visszavonva.';
    }

    async function startSchedule(input, extraInput, btn, status) {
        const offsetMs = getServerOffsetMs();
        const desired = parseDesiredTime(input.value, offsetMs); // szerveridőben
        const extraMs = (parseFloat(extraInput.value) || 0) + FIXED_COMPENSATION_MS;

        if (!desired) {
            status.textContent = 'adj meg egy érvényes időpontot (pl. 22:55:00:952)';
            return;
        }

        status.textContent = 'menetidő lekérése…';
        const fields = getFormFields();
        if (!fields) {
            status.textContent = 'nem található a csapatküldő űrlap';
            return;
        }
        const info = await getConfirmWithFields(fields);
        if (!info || info.durationSec == null) {
            status.textContent = 'nem sikerült lekérni a menetidőt (van cél és egység megadva?)';
            return;
        }

        const sendTimeServer = new Date(desired.getTime() - info.durationSec * 1000);
        const sendTimeClient = toClientTime(sendTimeServer, offsetMs);

        if (sendTimeClient.getTime() <= Date.now()) {
            status.textContent = 'erre az időpontra már nem ér oda a sereg';
            return;
        }

        running = true;
        btn.textContent = 'Ütemezés törlése';
        status.textContent = `indítás: ${fmtMs(sendTimeServer)} → érkezés: ${fmtMs(desired)} (szerveridő)`;

        // sendTimeClient itt csak a DURVA ütemezéshez kell (mikor lépjünk be a
        // záró, pontosító fázisba) - a tényleges kilövés célidejét a végén,
        // frissen mért eltolással/pinggel számoljuk újra sendTimeServer-ből.
        scheduleStep(sendTimeServer, sendTimeClient, extraMs, fields, btn, status);
    }

    function scheduleStep(sendTimeServer, sendTimeClient, extraMs, fields, btn, status) {
        const wait = sendTimeClient.getTime() - Date.now();

        if (wait <= REFRESH_BEFORE_MS) {
            timer = setTimeout(
                () => launchNow(sendTimeServer, extraMs, fields, btn, status),
                Math.max(0, wait)
            );
            return;
        }

        timer = setTimeout(
            () => scheduleStep(sendTimeServer, sendTimeClient, extraMs, fields, btn, status),
            Math.min(wait - REFRESH_BEFORE_MS, POLL_INTERVAL_MS)
        );
    }

    async function launchNow(sendTimeServer, extraMs, fields, btn, status) {
        status.textContent = 'véglegesítés: szerveridő + ping frissen lemérve…';

        // Friss szerveridő-eltolás ÉS egy tiszta hálózati ping, közvetlenül
        // indítás előtt mérve - nem az ütemezés indításakor (percekkel korábban)
        // kapott, esetleg már elavult értékekkel számolunk.
        const [offsetMs, pingMs] = await Promise.all([
            Promise.resolve(getServerOffsetMs()),
            measurePingMs(),
        ]);
        const sendTimeClient = toClientTime(sendTimeServer, offsetMs);

        // Friss megerősítés (friss ch/h tokenekért) - a MÁR MEGLÉVŐ mezőkkel,
        // nem töltjük le újra a "place" oldalt.
        const t0 = performance.now();
        const info = await getConfirmWithFields(fields);
        const measuredRttMs = performance.now() - t0;

        if (!info) {
            status.textContent = 'hiba: nem sikerült friss megerősítést kérni indítás előtt';
            running = false;
            btn.textContent = 'Időzített indítás';
            return;
        }

        // A hálózati egyirányú késleltetéssel korábbra toljuk az indítást, hogy a
        // kérés kb. pont a kívánt pillanatban érjen be a szerverhez, ne csak induljon.
        // A friss, tiszta ping-mérés elsőbbséget élvez a lapon mutatott Latency
        // értékkel szemben, mert ez épp most, erre az indításra mérve készült.
        const oneWayMs = pingMs / 2;
        const targetMs = sendTimeClient.getTime() - oneWayMs - extraMs;

        const { url, fields: cmdFields } = buildCommandRequest(info.confirmForm);
        const marginMs = sendTimeClient.getTime() - Date.now();

        status.textContent =
            `pontosítás… (offset: ${offsetMs.toFixed(0)} ms, ping: ${pingMs.toFixed(0)} ms, ` +
            `frissítés: ${measuredRttMs.toFixed(0)} ms, tartalék: ${marginMs.toFixed(0)} ms, ` +
            `extra: ${extraMs} ms)`;

        try {
            const res = await fireViaWorker(targetMs, url, cmdFields);
            const fireMoment = new Date(res.fireTs);
            status.textContent = res.ok
                ? `elindítva (${fmtMs(fireMoment)}, ping: ${pingMs.toFixed(0)} ms, offset: ${offsetMs.toFixed(0)} ms)`
                : `hiba: ${res.status ?? res.error}`;
        } catch (err) {
            console.error('Időzített támadás hiba:', err);
            status.textContent = 'hiba: ' + err.message;
        }
        running = false;
        btn.textContent = 'Időzített indítás';
    }

    addUi();
})();