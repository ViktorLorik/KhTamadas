// Támadás-küldő a Klánháború (Tribal Wars) Gyülekezőhelyéről.
//
// A munkamenetet (sütik) egyszer a böngészőből kell kimenteni a session.json-ba
// (lásd session.example.json és README-auto.md). Onnantól az alkalmazás teljesen
// önállóan küldi ki a megtervezett támadásokat.
//
// A küldés a játék saját űrlap-folyamatát használja (3 lépés, ahogy a böngésző is):
//   1. GET  game.php?village=<id>&screen=place             – a Gyülekezőhely űrlapja
//   2. POST game.php?village=<id>&screen=place&try=confirm – megerősítő oldal (ch token)
//   3. POST game.php?village=<id>&ajaxaction=popup_command&screen=place&h=<h> – indulás
//
// prepare() végrehajtja az 1–2. lépést, commit() a 3-at: így a commit() pillanata
// ms-ra pontosan időzíthető (a nemesvonat 4 része egymás után, néhány ms-on belül).

import { readFileSync } from 'node:fs';

export class SenderError extends Error {}

const UNIT_KEYS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];

const decodeEntities = (s) =>
  s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isNaN(n) ? m : String.fromCodePoint(n); }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[e] ?? m;
  });

/** <input name="..." value="..."> párok kinyerése (a játék űrlapmezői, ahogy a böngésző is elküldené). */
function extractInputs(html) {
  const out = {};
  const re = /<input[^>]*?name="([^"]+)"[^>]*?(?:value="([^"]*)")?[^>]*?>/g;
  let m;
  while ((m = re.exec(html))) {
    const name = m[1];
    if (name in out) continue;
    out[name] = decodeEntities(m[2] ?? '');
  }
  return out;
}

/** Beolvassa a munkamenet-fájlt. Hibánál érthető üzenettel dob. */
export function loadSession(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SenderError(`A munkamenet-fájl nem olvasható (${file}): ${err.message}`);
  }
  if (!data.cookies || typeof data.cookies !== 'object' || !Object.keys(data.cookies).length) {
    throw new SenderError(`A ${file} nem tartalmaz "cookies" objektumot – lásd session.example.json.`);
  }
  return data;
}

/**
 * Küldő létrehozása.
 * @param {object} p
 * @param {string} p.server    pl. "https://hu103.klanhaboru.hu"
 * @param {object} p.session   a loadSession() kimenete
 * @param {object} p.log       a logger (info/detail/warn/error)
 * @param {string} [p.attackLabel] a "Támadás" gomb felirata (alapból "Támadás")
 */
export function createSender({ server, session, log, attackLabel = 'Támadás', userAgent }) {
  const origin = server.replace(/\/+$/, '');
  const cookieHeader = Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  let csrfToken = null; // <meta name="csrf-token"> minden válaszból frissül
  let lastH = null;     // &h= token a legutóbbi oldalról

  function trackPage(html) {
    const xsrf = /<meta content="([^"]+)" name="csrf-token"/.exec(html);
    if (xsrf) csrfToken = decodeEntities(xsrf[1]);
    const h = /&h=(\w{6,})/.exec(html);
    if (h) lastH = h[1];
    if (/data-bot-protect="forced"/.test(html)) {
      throw new SenderError('Botvédelem (reCAPTCHA) aktiválódott: a játék emberi ellenőrzést kér. Nyisd meg a játékot a böngészőben, oldd meg a kérdést, majd próbáld újra.');
    }
    if (/<input[^>]+name="password"/.test(html) || /screen=welcome/.test(html)) {
      throw new SenderError('A munkamenet érvénytelen (bejelentkezési oldal jött vissza). Frissítsd a sütiket a session fájlban.');
    }
  }

  async function request(pathname, { method = 'GET', body = null, ajax = false } = {}) {
    const headers = {
      'User-Agent': userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept-Language': 'hu-HU,hu;q=0.9',
      Cookie: cookieHeader,
      Referer: `${origin}/game.php`,
    };
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    if (ajax) {
      headers['TribalWars-Ajax'] = '1';
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers['Accept'] = 'application/json, text/javascript, */*; q=0.01';
    }
    let payload;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      payload = new URLSearchParams(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])));
    }
    let res;
    try {
      res = await fetch(`${origin}/${pathname}`, { method, headers, body: payload, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new SenderError(`Hálózati hiba (${method} ${pathname}): ${err.message}`);
    }
    const text = await res.text();
    if (res.redirected && !res.url.includes('/game.php')) {
      throw new SenderError(`A munkamenet érvénytelen (átirányítás: ${res.url}). Frissítsd a sütiket a session fájlban.`);
    }
    trackPage(text);
    return { status: res.status, text };
  }

  /**
   * 1–2. lépés: a Gyülekezőhely űrlapjának kitöltése és a megerősítő oldal lekérése.
   * A visszaadott "prepared" objektumot commit()-tal lehet az indítás pillanatában elküldeni.
   */
  async function prepare({ sourceId, x, y, units, catapultTarget = null }) {
    if (!sourceId) throw new SenderError('Hiányzik a kiinduló falu azonosítója (a tervben a source.id, vagy a világadatokból).');
    // 1. lépés: a Gyülekezőhely oldala
    const place = await request(`game.php?village=${sourceId}&screen=place`);
    const data = extractInputs(place.text);
    // 2. lépés: egységek + célkoordináta, megerősítés kérése
    for (const u of UNIT_KEYS) delete data[u];
    for (const [u, n] of Object.entries(units)) {
      if (!UNIT_KEYS.includes(u)) throw new SenderError(`Ismeretlen egység: "${u}"`);
      if (Number(n) > 0) data[u] = n;
    }
    data.x = x;
    data.y = y;
    data.target_type = 'coord';
    data.attack = attackLabel;
    delete data.support; // a "Támogatás" gomb ne menjen ki véletlenül
    const conf = await request(`game.php?village=${sourceId}&screen=place&try=confirm`, { method: 'POST', body: data });
    const box = /<div class="error_box">([\s\S]*?)<\/div>/.exec(conf.text);
    if (box) throw new SenderError(`A játék visszautasította az indítást: ${box[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
    // 3. lépéshez: a megerősítő űrlap mezői (ch token stb.)
    const confirmData = extractInputs(conf.text);
    delete confirmData.support;
    confirmData.x = x;
    confirmData.y = y;
    confirmData.building = catapultTarget && catapultTarget !== 'TBD' ? catapultTarget : 'main';
    return { sourceId, confirmData };
  }

  /** 3. lépés: a tényleges indulás (az indítás pillanatában hívandó). */
  async function commit(prepared) {
    if (!lastH) throw new SenderError('Hiányzik az h token – a prepare() után kell hívni.');
    const body = { ...prepared.confirmData, h: lastH };
    const res = await request(`game.php?village=${prepared.sourceId}&ajaxaction=popup_command&screen=place&h=${lastH}`, {
      method: 'POST', body, ajax: true,
    });
    let json = null;
    try { json = JSON.parse(res.text); } catch { /* HTML válasz */ }
    if (res.status !== 200) throw new SenderError(`Az indulás nem sikerült (HTTP ${res.status}).`);
    const failed = json && (json.error === true || (typeof json.message === 'string' && /hiba|error/i.test(json.message)));
    if (failed) throw new SenderError(`Az indulás nem sikerült: ${json.message ?? res.text.slice(0, 200)}`);
    return { json, raw: res.text.slice(0, 500) };
  }

  /** Munkamenet gyors ellenőrzése a futás előtt (a saját falu Gyülekezőhelye). */
  async function checkSession(sourceId) {
    await request(`game.php?village=${sourceId}&screen=place`);
  }

  return { prepare, commit, checkSession, get h() { return lastH; } };
}
