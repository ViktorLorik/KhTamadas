// ==UserScript==
// @name         Térkép Fake gomb
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  A térkép (screen=map) kattintásra megjelenő kontextusmenübe ("Csapatok küldése" gomb mellé) egy "F" gombot ad, ami azonnal 1 kém + 1 kos (ha nincs, katapult) Fake-et indít a kiválasztott falura.
// @match        https://*.klanhaboru.hu/game.php*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    if (params.get('screen') !== 'map') return;

    const sourceVillage = params.get('village');
    if (!sourceVillage) return;

    const ALL_UNITS = [
        'spear', 'sword', 'axe', 'archer', 'spy', 'light',
        'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob',
    ];

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

    function getAvailableCount(doc, unitKey) {
        const input = doc.querySelector(`[name="${unitKey}"]`);
        if (!input) return 0;
        const n = parseInt(input.getAttribute('data-all-count'), 10);
        return Number.isNaN(n) ? 0 : n;
    }

    // A végső "action=command" POST-okat sorban küldjük - két egyszerre
    // befutó kérés ugyanarra az URL-re 405-öt válthat ki.
    let commandQueue = Promise.resolve();
    function queueCommand(url, fields) {
        const run = commandQueue.then(() => fetchText(url, fields));
        commandQueue = run.catch(() => {});
        return run;
    }

    async function sendFakeToTarget(targetId, onStatus) {
        try {
            const placeUrl = `/game.php?village=${sourceVillage}&screen=place&target=${targetId}`;
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

            // Az x/y mezők a nyers HTML-ben ÜRESEN szerepelnek - a lap ezeket
            // csak saját JS-sel tölti ki futásidőben (target_widget.setVillageByData),
            // amit mi nem futtatunk le. Ugyanez az adat viszont megtalálható egy
            // beágyazott <script>-ben JSON formában - onnan szedjük ki.
            const villageDataMatch = place.text.match(/target_widget\.setVillageByData\((\{[\s\S]*?\})\)\s*;/);
            if (villageDataMatch) {
                try {
                    const villageData = JSON.parse(villageDataMatch[1]);
                    if (villageData.x && villageData.y) {
                        fields.x = String(villageData.x);
                        fields.y = String(villageData.y);
                        fields.target_type = 'coord';
                    }
                } catch (err) {
                    console.warn('Térkép Fake gomb – nem sikerült feldolgozni a cél JSON adatait:', err, villageDataMatch[1]);
                }
            }

            console.log(`Térkép Fake gomb – cél ${targetId}: kiolvasott x=${fields.x}, y=${fields.y}, target_type=${fields.target_type}`);
            if (!fields.x || !fields.y) {
                onStatus('hiba: nincs kitöltve a célpont koordinátája (x/y üres)');
                return false;
            }

            ALL_UNITS.forEach((u) => {
                fields[u] = '0';
            });
            fields.spy = '1';
            fields[unitKey] = '1';
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
                console.warn('Térkép Fake gomb – nincs megerősítő űrlap:', confirm.text);
                onStatus(`hiba: nincs megerősítő űrlap (${unitUsed})`);
                return false;
            }

            const action = confirmForm.getAttribute('action') || '';
            const hMatch = action.match(/[?&]h=([^&]+)/);
            const h = hMatch ? hMatch[1] : '';

            const step2Fields = harvestForm(confirmForm);
            step2Fields.cb = 'troop_confirm_submit';
            step2Fields.submit_confirm = 'Támadás indítása';

            const commandUrl = `/game.php?village=${sourceVillage}&screen=place&action=command&h=${encodeURIComponent(h)}`;
            const result = await queueCommand(commandUrl, step2Fields);

            if (!result.ok) {
                onStatus(`hiba: ${result.status} (${unitUsed})`);
                return false;
            }

            onStatus(`elküldve (${unitUsed})`);
            return true;
        } catch (err) {
            console.error('Térkép Fake gomb hiba:', err);
            onStatus('hiba: ' + err.message);
            return false;
        }
    }

    // ---- Az "F" gomb beillesztése a kontextusmenübe ----

    let fButton = null;

    function ensureFButton(container) {
        if (fButton && container.contains(fButton)) return fButton;
        fButton = document.createElement('a');
        fButton.className = 'mp';
        fButton.id = 'mp_fake';
        fButton.href = '#';
        fButton.textContent = 'F';
        fButton.setAttribute('data-title', 'Fake indítása (kém + kos/katapult)');
        fButton.style.cssText = [
            'display:none', 'opacity:0', 'position:absolute',
            'width:18px', 'height:18px', 'line-height:18px', 'text-align:center',
            'font-weight:bold', 'font-size:11px', 'color:#fff',
            'background:#a33', 'border:1px solid #600', 'border-radius:3px',
            'cursor:pointer', 'z-index:50',
        ].join(';');

        fButton.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const targetId = fButton.dataset.targetId;
            if (!targetId) return;

            const original = fButton.textContent;
            fButton.textContent = '…';
            sendFakeToTarget(targetId, (msg) => {
                console.log(`Térkép Fake gomb – cél ${targetId}: ${msg}`);
                fButton.textContent = msg.startsWith('elküldve') ? '✓' : '✗';
                fButton.title = msg;
                setTimeout(() => {
                    fButton.textContent = original;
                    fButton.title = '';
                }, 2500);
            });
        });

        container.appendChild(fButton);
        return fButton;
    }

    // Ctrl+klikk a térképen -> amint a kontextusmenü a kattintott falura
    // frissül, automatikusan elindítjuk az F gomb logikáját (nem kell rá
    // külön kattintani).
    let autoFireNext = false;
    let lastAutoFiredTarget = null;

    document.addEventListener(
        'click',
        (ev) => {
            // A térkép kattintható területe a #map elem (rajta az #map_mover
            // réteg fogja a tényleges kattintásokat) - csak ott reagálunk.
            const onMap = ev.target.closest('#map');
            autoFireNext = !!(ev.ctrlKey && onMap);
        },
        true
    );

    function syncFButton() {
        const container = document.getElementById('map-ctx-buttons');
        if (!container) return;

        const attBtn = container.querySelector('#mp_att');
        if (!attBtn) return;

        const btn = ensureFButton(container);
        const visible = attBtn.style.display !== 'none' && attBtn.style.opacity !== '0';

        if (!visible) {
            btn.style.display = 'none';
            btn.style.opacity = '0';
            return;
        }

        const targetMatch = (attBtn.getAttribute('href') || '').match(/[?&]target=(\d+)/);
        if (!targetMatch) {
            btn.style.display = 'none';
            btn.style.opacity = '0';
            return;
        }
        btn.dataset.targetId = targetMatch[1];

        // Az "mp_att" (Csapatok küldése) pozíciója mellé tesszük, kicsit eltolva,
        // hogy ne fedje.
        const left = parseFloat(attBtn.style.left) || 0;
        const top = parseFloat(attBtn.style.top) || 0;
        btn.style.left = `${left + 34}px`;
        btn.style.top = `${top}px`;
        btn.style.display = 'block';
        btn.style.opacity = '1';

        if (autoFireNext && btn.dataset.targetId !== lastAutoFiredTarget) {
            autoFireNext = false;
            lastAutoFiredTarget = btn.dataset.targetId;
            btn.click();
        }
    }

    function observeMap() {
        const container = document.getElementById('map-ctx-buttons');
        if (!container) {
            // A térkép (és ezzel a menü konténere) lehet, hogy csak később
            // töltődik be - rövid késleltetéssel újrapróbáljuk.
            setTimeout(observeMap, 500);
            return;
        }

        const observer = new MutationObserver(() => syncFButton());
        observer.observe(container, {
            attributes: true,
            attributeFilter: ['style', 'href'],
            subtree: true,
        });

        syncFButton();
    }

    observeMap();
})();