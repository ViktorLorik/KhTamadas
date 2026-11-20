// ==UserScript==
// @name         Nemesvonat
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  A csapatküldő (screen=place) oldalon egy "Nemesvonat" gomb: az oldalon megadott célpontra 4 támadást indít egymás után a lehető leggyorsabban. 1. támadás: a teljes sereg - 3 nemes - 300 bárd. A maradék 3 támadás: 1 nemes + 100 bárd. Az első mindig elsőként megy ki.
// @match        https://*.klanhaboru.hu/game.php*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    if (params.get('screen') !== 'place') return;

    const sourceVillage = params.get('village');
    if (!sourceVillage) return;

    // Csak a csapatküldő űrlapon fusson (a megerősítő oldalon és a többi
    // fülön - gyűjtögetés, szimulátor stb. - ne jelenjen meg).
    if (!document.querySelector('input.unitsInput[name="spy"]')) return;

    // ---- Beállítások ----

    // A vonat 2.-4. támadásainak összetétele (mindegyik ennyit visz).
    const TRAIN_ATTACK_UNITS = { snob: 1, axe: 100 };
    const TRAIN_ATTACK_COUNT = 3;

    // Az 1. támadásból ezeket a típusokat kihagyjuk teljesen (pl. ['knight'],
    // ha a lovagot itthon akarod tartani). Alapból üres: teljes sereg megy.
    const FIRST_ATTACK_EXCLUDE = [];

    // Indítás előtt egy összefoglaló ablak, mert ez az egész sereget útnak indítja.
    const REQUIRE_CONFIRM = true;

    const ALL_UNITS = [
        'spear', 'sword', 'axe', 'archer', 'spy', 'light',
        'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob',
    ];

    const UNIT_NAMES = {
        spear: 'lándzsás', sword: 'kardos', axe: 'bárd', archer: 'íjász',
        spy: 'kém', light: 'könnyűlovas', marcher: 'lovas íjász',
        heavy: 'nehézlovas', ram: 'kos', catapult: 'katapult',
        knight: 'lovag', snob: 'nemes',
    };

    // ---- Segédfüggvények ----

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

    function getSendForm(doc) {
        const spyInput = doc.querySelector('input.unitsInput[name="spy"]');
        return spyInput ? spyInput.closest('form') : null;
    }

    function getAvailable(doc, unitKey) {
        const input = doc.querySelector(`input.unitsInput[name="${unitKey}"]`);
        if (!input) return 0;
        const n = parseInt(input.getAttribute('data-all-count'), 10);
        return Number.isNaN(n) ? 0 : n;
    }

    // A célpont koordinátája: a lap saját rejtett x/y mezőiből (ezeket a lap
    // JS-e tölti ki, amikor kiválasztasz egy célpontot), ennek hiányában a
    // célpont szövegmezőbe írt "x|y" alakból.
    function readTarget() {
        const x = (document.getElementById('inputx') || {}).value;
        const y = (document.getElementById('inputy') || {}).value;
        if (x && y) return { x: String(x), y: String(y) };

        const input = document.querySelector('input[name="input"]');
        const m = input && input.value.match(/(\d+)\s*\|\s*(\d+)/);
        return m ? { x: m[1], y: m[2] } : null;
    }

    // A szerver idő (#serverTime / #serverDate) és a kliens gép órája közti eltolás,
    // hogy az érkezést a szerver órája szerint mutassuk.
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

        return new Date(year, month, day, hh, mm, ss, ms).getTime() - now.getTime();
    }

    function formatArrival(date, nowServer) {
        const pad = (n) => String(n).padStart(2, '0');
        const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

        if (date.toDateString() === nowServer.toDateString()) return `ma ${time}`;

        const tomorrow = new Date(nowServer);
        tomorrow.setDate(nowServer.getDate() + 1);
        if (date.toDateString() === tomorrow.toDateString()) return `holnap ${time}`;

        return `${pad(date.getMonth() + 1)}.${pad(date.getDate())}. ${time}`;
    }

    // ---- A vonat összeállítása ----

    function buildPlans(doc) {
        const avail = {};
        ALL_UNITS.forEach((u) => {
            avail[u] = getAvailable(doc, u);
        });

        // A 2-4. támadásokhoz félretartandó mennyiségek.
        const reserve = {};
        Object.keys(TRAIN_ATTACK_UNITS).forEach((u) => {
            reserve[u] = TRAIN_ATTACK_UNITS[u] * TRAIN_ATTACK_COUNT;
        });

        const missing = Object.keys(reserve).filter((u) => avail[u] < reserve[u]);
        if (missing.length) {
            return {
                error: 'nincs elég egység a vonathoz: ' + missing
                    .map((u) => `${UNIT_NAMES[u]} (kell: ${reserve[u]}, van: ${avail[u]})`)
                    .join(', '),
            };
        }

        const first = {};
        ALL_UNITS.forEach((u) => {
            first[u] = FIRST_ATTACK_EXCLUDE.includes(u)
                ? 0
                : Math.max(0, avail[u] - (reserve[u] || 0));
        });

        const rest = ALL_UNITS.reduce((acc, u) => {
            acc[u] = TRAIN_ATTACK_UNITS[u] || 0;
            return acc;
        }, {});

        const plans = [first];
        for (let i = 0; i < TRAIN_ATTACK_COUNT; i++) plans.push(rest);
        return { plans };
    }

    function describeUnits(units) {
        const parts = ALL_UNITS
            .filter((u) => units[u] > 0)
            .map((u) => `${units[u]} ${UNIT_NAMES[u]}`);
        return parts.length ? parts.join(', ') : '(üres)';
    }

    function applyPlan(baseFields, units, target) {
        const fields = Object.assign({}, baseFields);
        ALL_UNITS.forEach((u) => {
            fields[u] = String(units[u] || 0);
        });
        fields.x = target.x;
        fields.y = target.y;
        fields.target_type = 'coord';
        fields.source_village = sourceVillage;
        fields.village = sourceVillage;
        fields.input = '';
        fields.attack = 'Támadás';
        fields.template_id = '';
        delete fields.support; // az "Erősítés" gomb mezője ne menjen el
        return fields;
    }

    // ---- Megerősítés + indítás ----

    async function confirmFields(fields) {
        try {
            const r = await fetchText(
                `/game.php?village=${sourceVillage}&screen=place&try=confirm`,
                fields
            );
            const doc = parseDoc(r.text);
            const form = doc.querySelector('#command-data-form');
            if (!form || !(form.getAttribute('action') || '').includes('action=command')) {
                console.warn('Nemesvonat – nincs megerősítő űrlap:', r.text);
                return null;
            }

            // Menetidő másodpercben (ebből számoljuk az érkezést).
            let durationSec = null;
            const durationEl = doc.querySelector('.relative_time[data-duration]');
            if (durationEl) {
                const d = parseInt(durationEl.getAttribute('data-duration'), 10);
                if (!Number.isNaN(d)) durationSec = d;
            }

            return { form, durationSec };
        } catch (err) {
            console.error('Nemesvonat – megerősítés hiba:', err);
            return null;
        }
    }

    // Tartalék út: friss "place" oldalról új alapmezők (friss tokenekkel),
    // majd újra megerősítés ugyanazzal a tervvel.
    async function confirmWithFreshBase(units, target) {
        try {
            const place = await fetchText(`/game.php?village=${sourceVillage}&screen=place`);
            const form = getSendForm(parseDoc(place.text));
            if (!form) return null;
            return confirmFields(applyPlan(harvestForm(form), units, target));
        } catch (err) {
            console.error('Nemesvonat – tartalék megerősítés hiba:', err);
            return null;
        }
    }

    async function sendConfirmed(confirmForm) {
        const action = confirmForm.getAttribute('action') || '';
        const hMatch = action.match(/[?&]h=([^&]+)/);
        const h = hMatch ? hMatch[1] : '';

        const fields = harvestForm(confirmForm);
        fields.cb = 'troop_confirm_submit';
        fields.submit_confirm = 'Támadás indítása';

        const url = `/game.php?village=${sourceVillage}&screen=place&action=command&h=${encodeURIComponent(h)}`;
        return fetchText(url, fields);
    }

    async function runTrain(btn, panel) {
        panel.innerHTML = '';
        const addLine = (text) => {
            const line = document.createElement('div');
            line.textContent = text;
            panel.appendChild(line);
            return line;
        };

        const target = readTarget();
        if (!target) {
            addLine('hiba: nincs kiválasztva célpont (x|y)');
            return;
        }

        const built = buildPlans(document);
        if (built.error) {
            addLine('hiba: ' + built.error);
            return;
        }
        const plans = built.plans;

        btn.disabled = true;
        btn.textContent = 'Fut…';

        const lines = plans.map((p, i) => addLine(`${i + 1}. előkészítés…`));

        const base = harvestForm(getSendForm(document));

        // 1. lépés: az összes megerősítést EGYSZERRE kérjük le. Ez csak előnézet,
        // nem küld el semmit - innen kapjuk a menetidőket is az érkezéshez.
        const confirms = await Promise.all(
            plans.map((p) => confirmFields(applyPlan(base, p, target)))
        );

        if (REQUIRE_CONFIRM) {
            const offsetMs = getServerOffsetMs();
            const nowServer = new Date(Date.now() + offsetMs);

            const summary = plans
                .map((p, i) => {
                    const c = confirms[i];
                    const arrival = c && c.durationSec != null
                        ? formatArrival(new Date(nowServer.getTime() + c.durationSec * 1000), nowServer)
                        : '?';
                    return `${i + 1}. támadás: ${describeUnits(p)}\n    érkezés (ha most indul): ${arrival}`;
                })
                .join('\n');

            const ok = window.confirm(
                `Nemesvonat indítása erre: ${target.x}|${target.y}\n\n${summary}\n\nIndulhat?`
            );
            if (!ok) {
                panel.innerHTML = '';
                addLine('megszakítva');
                btn.textContent = 'Nemesvonat';
                btn.disabled = false;
                return;
            }
        }

        // 2. lépés: a végső indításokat szigorúan SORBAN küldjük, mindegyikre
        // megvárva a választ - így az 1. támadás garantáltan előbb megy ki, mint
        // a többi. Ha egy megerősítés közben lejárt (pl. az ablak nyitva volt),
        // friss tokennel újrakérjük.
        let sent = 0;
        for (let i = 0; i < plans.length; i++) {
            let c = confirms[i];
            if (!c) {
                lines[i].textContent = `${i + 1}. újrapróbálás friss tokennel…`;
                c = await confirmWithFreshBase(plans[i], target);
            }

            if (!c) {
                lines[i].textContent = `${i + 1}. hiba: nem sikerült megerősítést kérni`;
                addLine(i === 0
                    ? 'az 1. támadás nem ment ki, a többit nem indítottam el'
                    : 'a vonat megszakadt, a hátralévő támadások nem mentek ki');
                break;
            }

            try {
                const result = await sendConfirmed(c.form);
                if (!result.ok) {
                    lines[i].textContent = `${i + 1}. hiba: ${result.status}`;
                    addLine(i === 0
                        ? 'az 1. támadás nem ment ki, a többit nem indítottam el'
                        : 'a vonat megszakadt, a hátralévő támadások nem mentek ki');
                    break;
                }
                lines[i].textContent = `${i + 1}. elküldve (${describeUnits(plans[i])})`;
                sent++;
            } catch (err) {
                console.error('Nemesvonat – indítás hiba:', err);
                lines[i].textContent = `${i + 1}. hiba: ${err.message}`;
                break;
            }
        }

        addLine(`Kész: ${sent}/${plans.length} támadás elküldve`);
        btn.textContent = 'Nemesvonat';
        btn.disabled = false;
    }

    // ---- UI ----

    function addUi() {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = [
            'position:fixed', 'top:10px', 'left:10px', 'z-index:99999',
            'background:#fdf6e3', 'border:2px solid #7d510f', 'border-radius:4px',
            'padding:8px', 'font-size:12px', 'max-width:300px',
        ].join(';');

        const btn = document.createElement('button');
        btn.textContent = 'Nemesvonat';
        btn.style.cssText = [
            'width:100%', 'padding:8px', 'cursor:pointer', 'background:#f4e4bc',
            'border:2px solid #7d510f', 'border-radius:4px', 'font-size:13px',
        ].join(';');
        wrapper.appendChild(btn);

        const panel = document.createElement('div');
        panel.style.cssText = 'margin-top:6px;display:flex;flex-direction:column;gap:2px;';
        wrapper.appendChild(panel);

        btn.addEventListener('click', () => runTrain(btn, panel));

        document.body.appendChild(wrapper);
    }

    addUi();
})();
