// ==UserScript==
// @name         Farm Assistant - B/C gombok
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Végigkattintja a farm asszisztens sorait (0,5 mp szünettel): B gomb, teljes fosztogatásnál C gomb. Kihagyja a folyamatban levő támadással rendelkező sorokat.
// @match        https://*.klanhaboru.hu/game.php*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Csak a farm asszisztens oldalon fusson
    if (!/[?&]screen=am_farm/.test(location.search)) return;

    const DELAY_MS = 251; // szünet két gombnyomás között
    const FULL_LOOT_TITLE = 'Teljes fosztogatás: Katonáid annyit zsákmányoltak, amennyit el tudtak cipelni.';

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    let running = false;

    // Bármilyen folyamatban levő támadás (1, 2, 3... db) -> kihagyjuk a sort.
    // Két módon ismeri fel: a támadás ikon képe alapján, vagy a tooltip szövege alapján.
    function hasOngoingAttack(row) {
        return !!row.querySelector(
            'img[src*="/command/attack"], [data-title*="folyamatban"], [title*="folyamatban"]'
        );
    }

    function hasFullLoot(row) {
        return !!row.querySelector(
            `[data-title="${FULL_LOOT_TITLE}"], [title="${FULL_LOOT_TITLE}"]`
        );
    }

    function getActiveButton(row, selector) {
        const btn = row.querySelector(selector);
        if (!btn) return null;
        if (btn.classList.contains('farm_icon_disabled')) return null;
        return btn;
    }

    // Teljes fosztogatás -> C gomb; ha az nem aktív, B gomb. Egyébként B gomb.
    function getButton(row) {
        if (hasFullLoot(row)) {
            const c = getActiveButton(row, 'a.farm_icon_c');
            if (c) return c;
        }
        return getActiveButton(row, 'a.farm_icon_b');
    }

    async function clickAllB(uiButton) {
        running = true;
        uiButton.textContent = '⏹ Leállítás';

        const rows = Array.from(document.querySelectorAll('tr[id^="village_"]'));
        let clicked = 0;

        for (const row of rows) {
            if (!running) break;
            if (!row.isConnected || row.style.display === 'none') continue;
            if (hasOngoingAttack(row)) continue;

            const btn = getButton(row);
            if (!btn) continue;

            btn.click();
            clicked++;
            uiButton.textContent = `⏹ Leállítás (${clicked})`;
            await sleep(DELAY_MS);
        }

        running = false;
        uiButton.textContent = `▶ B/C gombok (kész: ${clicked})`;
    }

    function addUi() {
        const btn = document.createElement('button');
        btn.textContent = '▶ B/C gombok';
        btn.style.cssText = [
            'position:fixed',
            'top:10px',
            'right:10px',
            'z-index:99999',
            'padding:8px 14px',
            'font-size:14px',
            'cursor:pointer',
            'background:#f4e4bc',
            'border:2px solid #7d510f',
            'border-radius:4px',
        ].join(';');

        btn.addEventListener('click', () => {
            if (running) {
                running = false; // leállítás
            } else {
                clickAllB(btn);
            }
        });

        document.body.appendChild(btn);
    }

    addUi();
})();