// ==UserScript==
// @name         Gyors 4x támadás (info_village)
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Falu megtekintő oldalon (screen=info_village) gombot ad, ami a falu koordinátáira 4 támadást indít (kém+kos VAGY kém+katapult), 100-200 ms közötti véletlen késleltetéssel.
// @match        https://*.klanhaboru.hu/game.php*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    if (params.get('screen') !== 'info_village') return;

    const sourceVillage = params.get('village');
    if (!sourceVillage) return;

    const ATTACK_COUNT = 4;
    const DELAY_MIN = 50; // ms
    const DELAY_MAX = 150; // ms

    // A két választható kombináció
    const COMBOS = {
        A: { label: 'Kém + Kos', spy: 1, ram: 1 },
        B: { label: 'Kém + Katapult', spy: 1, catapult: 1 },
    };

    const ALL_UNITS = [
        'spear', 'sword', 'axe', 'archer', 'spy', 'light',
        'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob',
    ];

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const randDelay = () => DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);

    function findCoords() {
        const rows = document.querySelectorAll('tr');
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2 && /^Koordináták/.test(cells[0].textContent.trim())) {
                const m = cells[1].textContent.match(/(\d+)\|(\d+)/);
                if (m) return { x: m[1], y: m[2] };
            }
        }
        return null;
    }

    const TARGET_BUILDING = 'smith'; // Kovácsműhely

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

    // A végső "action=command" POST-okat egymás után, sorban küldjük ki -
    // ha két ilyen kérés szinte egyszerre futna be ugyanarra az URL-re,
    // a szerver 405-tel elutasíthatja az egyiket.
    let commandQueue = Promise.resolve();

    function queueCommand(url, fields) {
        const run = commandQueue.then(() => fetchText(url, fields));
        commandQueue = run.catch(() => {});
        return run;
    }

    function parseDoc(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    // Egy form (vagy adott elem) összes megnevezett mezőjét kigyűjti név->érték térképbe.
    // Így az esetleges random nevű anti-bot/CSRF mezőket is automatikusan megőrzi,
    // anélkül, hogy a nevüket ismerni kellene.
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

    function formatArrival(date) {
        const now = new Date();
        const sameDay = date.toDateString() === now.toDateString();
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);
        const isTomorrow = date.toDateString() === tomorrow.toDateString();

        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        const ss = String(date.getSeconds()).padStart(2, '0');
        const time = `${hh}:${mm}:${ss}`;

        if (sameDay) return `ma ${time}`;
        if (isTomorrow) return `holnap ${time}`;
        const dd = String(date.getDate()).padStart(2, '0');
        const MM = String(date.getMonth() + 1).padStart(2, '0');
        return `${MM}.${dd}. ${time}`;
    }

    // Lekéri a friss "place" oldalt, majd a "try=confirm" előnézetet - ez NEM küld
    // el semmit, csak egy megerősítő oldalt ad vissza (ebből olvassuk ki az időt is).
    async function getConfirm(combo) {
        const placeUrl = `/game.php?village=${sourceVillage}&screen=place`;
        const place = await fetchText(placeUrl);
        const placeDoc = parseDoc(place.text);
        const attackBtn = placeDoc.querySelector('input[name="attack"]');
        const sendForm = attackBtn ? attackBtn.closest('form') : placeDoc.querySelector('form');

        if (!sendForm) return null;

        const fields = harvestForm(sendForm);
        ALL_UNITS.forEach((u) => {
            fields[u] = String(combo[u] || 0);
        });
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
            console.warn('Gyors támadás – megerősítő oldal válasza:', confirm.text);
            return null;
        }

        // Érkezési idő kiolvasása (a hátralévő időtartam másodpercben, a saját gépünk
        // órájához hozzáadva - ez közelítő, a hálózati késleltetés miatt pár mp eltérhet).
        let arrival = null;
        const durationEl = confirmDoc.querySelector('.relative_time[data-duration]');
        if (durationEl) {
            const durationSec = parseInt(durationEl.getAttribute('data-duration'), 10);
            if (!Number.isNaN(durationSec)) {
                arrival = new Date(Date.now() + durationSec * 1000);
            }
        }

        return { confirmForm, arrival };
    }

    // Csak az előzetes érkezési idő lekéréséhez (nem küld el semmit).
    async function fetchEta(combo) {
        try {
            const info = await getConfirm(combo);
            return info ? info.arrival : null;
        } catch (err) {
            console.error('ETA lekérés hiba:', err);
            return null;
        }
    }

    // Elvégzi a 0-1-2. lépést egyszer (friss place oldal -> try=confirm -> action=command).
    // Visszaadja: { result: {status, ok, text} | null, arrival: Date | null }
    async function attemptOnce(combo, onStatus) {
        const info = await getConfirm(combo);

        if (!info) {
            onStatus('hiba: nincs megerősítő űrlap (elég egység van a faluban?)');
            return { result: null, arrival: null };
        }

        const { confirmForm, arrival } = info;

        const action = confirmForm.getAttribute('action') || '';
        const hMatch = action.match(/[?&]h=([^&]+)/);
        const h = hMatch ? hMatch[1] : '';

        const step2Fields = harvestForm(confirmForm);
        step2Fields.cb = 'troop_confirm_submit';
        step2Fields.submit_confirm = 'Támadás indítása';
        step2Fields.building = TARGET_BUILDING;

        const commandUrl = `/game.php?village=${sourceVillage}&screen=place&action=command&h=${encodeURIComponent(h)}`;
        const result = await queueCommand(commandUrl, step2Fields);
        return { result, arrival };
    }

    async function sendOneAttack(combo, onStatus) {
        try {
            let { result, arrival } = await attemptOnce(combo, onStatus);

            if (result && !result.ok) {
                onStatus(`újrapróbálás (${result.status})`);
                await sleep(150);
                ({ result, arrival } = await attemptOnce(combo, onStatus));
            }

            if (!result) return false;

            if (!result.ok) {
                onStatus('hiba: ' + result.status);
                console.warn('Gyors támadás – végső válasz:', result.status, result.text);
                return false;
            }

            onStatus('elküldve');
            return true;
        } catch (err) {
            console.error('Gyors támadás hiba:', err);
            onStatus('hiba: ' + err.message);
            return false;
        }
    }

    async function launchAttacks(combo, btn, panel) {
        btn.disabled = true;
        const lines = [];
        panel.innerHTML = '';
        for (let i = 0; i < ATTACK_COUNT; i++) {
            const line = document.createElement('div');
            line.textContent = `${i + 1}. indítás…`;
            panel.appendChild(line);
            lines.push(line);
        }

        const promises = [];
        let delayAcc = 0;

        for (let i = 0; i < ATTACK_COUNT; i++) {
            const idx = i;
            const startDelay = delayAcc;
            if (i < ATTACK_COUNT - 1) delayAcc += randDelay();

            promises.push(
                sleep(startDelay).then(() =>
                    sendOneAttack(combo, (msg) => {
                        lines[idx].textContent = `${idx + 1}. ${msg}`;
                    })
                )
            );
        }

        const results = await Promise.all(promises);
        const ok = results.filter(Boolean).length;
        btn.textContent = `Kész: ${ok}/${ATTACK_COUNT} sikeres`;
        btn.disabled = false;
    }

    function addButton(key, top, coords) {
        const combo = COMBOS[key];
        const label = `${key}: ${combo.label} x${ATTACK_COUNT} → ${coords.x}|${coords.y}`;

        const wrapper = document.createElement('div');
        wrapper.style.cssText = [
            'position:fixed',
            `top:${top}px`,
            'right:10px',
            'z-index:99999',
            'max-width:260px',
            'font-size:12px',
            'text-align:right',
        ].join(';');

        const btn = document.createElement('button');
        btn.textContent = label;
        btn.dataset.label = label;
        btn.style.cssText = [
            'padding:8px 14px',
            'font-size:13px',
            'cursor:pointer',
            'background:#f4e4bc',
            'border:2px solid #7d510f',
            'border-radius:4px',
            'width:100%',
        ].join(';');

        const etaLine = document.createElement('div');
        etaLine.textContent = 'érkezés kiszámítása…';
        etaLine.style.cssText = [
            'background:#fdf6e3',
            'border:1px solid #7d510f',
            'border-top:none',
            'padding:3px 6px',
            'font-style:italic',
        ].join(';');

        const panel = document.createElement('div');
        panel.style.cssText = [
            'background:#fdf6e3',
            'border:1px solid #7d510f',
            'border-top:none',
            'padding:4px 6px',
            'display:flex',
            'flex-direction:column',
            'gap:2px',
        ].join(';');

        btn.addEventListener('click', () => launchAttacks(combo, btn, panel));
        wrapper.appendChild(btn);
        wrapper.appendChild(etaLine);
        wrapper.appendChild(panel);
        document.body.appendChild(wrapper);

        // Egyszeri, statikus becslés: mikor érne be, ha PONT MOST indítanánk.
        // Nem frissül folyamatosan.
        fetchEta(combo).then((arrival) => {
            etaLine.textContent = arrival
                ? `ha most indítanád: ${formatArrival(arrival)}`
                : 'nem sikerült lekérni az időt';
        });
    }

    const coords = findCoords();
    if (!coords) return;

    addButton('A', 10, coords);
    addButton('B', 130, coords);
})();