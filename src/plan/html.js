// Önálló HTML indítópult generálása a tervből.
// A fájl szerver nélkül, dupla kattintással megnyitható. Élő óra, visszaszámlálók, figyelmeztetés (hang + villogó cím),
// "Megnyitás" link a megfelelő falu Gyülekezőhelyére a célkoordinátákkal, és "kiment" pipa (böngészőben tárolva).
// Az oldal semmit nem küld: a küldés a játékban, a te kattintásodra történik.

import { unitsText } from './plan.js';

const placeUrl = (server, sourceId, coord) => {
  if (!server || !sourceId) return null;
  const [x, y] = coord.split('|');
  return `${server}/game.php?village=${sourceId}&screen=place&x=${x}&y=${y}`;
};

export function buildDashboardData({ meta, commands }, issues, world) {
  const server = world?.server ?? (meta.server ? new URL(meta.server).origin : null);
  return {
    title: meta.plan ?? 'Támadási terv',
    world: world ? { name: world.world, speed: world.speed, unitSpeed: world.unitSpeed } : null,
    generatedAt: new Date().toISOString(),
    general: issues.filter((i) => i.order === null).map((i) => ({ level: i.level, text: i.text })),
    commands: commands.map((c) => {
      const sourceId = c.source.id ?? world?.villageAt(c.source.coord)?.id ?? null;
      const tw = c.target.world;
      return {
        order: c.order,
        role: c.role,
        roleName: c.roleName,
        launch: c.launch,
        arrival: c.arrival,
        source: { name: c.source.name ?? c.source.coord, coord: c.source.coord },
        target: {
          coord: c.target.coord,
          label: c.target.label,
          name: tw?.name ?? c.target.name ?? null,
          owner: tw ? (tw.owner?.name ?? 'barbár') : null,
          points: tw?.points ?? null,
        },
        catapultTarget: c.catapultTarget,
        note: c.note,
        parts: c.parts.map((p) => ({ label: p.label, units: unitsText(p.units) })),
        url: placeUrl(server, sourceId, c.target.coord),
        issues: issues.filter((i) => i.order === c.order).map((i) => ({ level: i.level, text: i.text })),
      };
    }),
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

export function renderDashboard(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)}</title>
<style>
  :root {
    --bg: #f6f5f2; --panel: #ffffff; --text: #1d1c1a; --muted: #6b6862; --line: #e3e0da;
    --accent: #b4532a; --ok: #2f7d4f; --warn: #b7791f; --bad: #c0392b; --soon: #fff4e0; --now: #ffe1d6; --done: #eef5ef;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151412; --panel: #1f1d1a; --text: #ece9e3; --muted: #9b968d; --line: #34312c;
      --accent: #e0804f; --ok: #5cb67f; --warn: #e0a84a; --bad: #ef6b5b; --soon: #3a2f1c; --now: #4a2a1f; --done: #1f2b22; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 60px; }
  header { display: flex; flex-wrap: wrap; gap: 16px 32px; align-items: end; justify-content: space-between; margin-bottom: 18px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; }
  .clock { font: 600 34px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; font-variant-numeric: tabular-nums; }
  .clock small { font-size: 18px; color: var(--muted); }
  .next { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; }
  .next .cd { font: 700 28px/1 ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; color: var(--accent); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 14px; font-size: 14px; }
  .toolbar input[type=number] { width: 90px; font: inherit; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; }
  button, .btn { font: inherit; border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 8px; padding: 6px 12px; cursor: pointer; text-decoration: none; display: inline-block; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .btn[aria-disabled=true] { opacity: .45; pointer-events: none; }
  .issues { background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--warn); border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; }
  .issues ul { margin: 6px 0 0; padding-left: 18px; }
  .issue-warn { color: var(--warn); } .issue-info { color: var(--muted); }
  .cmd { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; display: grid; grid-template-columns: 64px 1fr auto; gap: 6px 14px; align-items: start; }
  .cmd.soon { background: var(--soon); border-color: var(--warn); }
  .cmd.now { background: var(--now); border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
  .cmd.done { background: var(--done); opacity: .75; }
  .cmd.missed { border-color: var(--bad); }
  .num { font: 700 20px/1 ui-monospace, Consolas, monospace; color: var(--muted); padding-top: 2px; }
  .when { font: 600 17px/1.2 ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; }
  .when .ms { color: var(--muted); }
  .cd-small { font: 600 15px ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; color: var(--accent); }
  .route { margin-top: 2px; } .route b { font-weight: 600; }
  .meta { color: var(--muted); font-size: 13px; }
  .parts { margin: 6px 0 0; padding: 0; list-style: none; font-size: 13.5px; }
  .parts li { padding: 2px 0; border-top: 1px dashed var(--line); }
  .parts li:first-child { border-top: 0; }
  .tag { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--line); margin-left: 6px; color: var(--muted); }
  .side { display: flex; flex-direction: column; gap: 8px; align-items: stretch; min-width: 130px; }
  .side label { font-size: 14px; display: flex; gap: 6px; align-items: center; }
  .cmd-issues { grid-column: 2 / 4; margin: 2px 0 0; padding-left: 18px; font-size: 13px; }
  .hidden { display: none !important; }
  @media (max-width: 640px) {
    .cmd { grid-template-columns: 40px 1fr; }
    .side { grid-column: 1 / 3; flex-direction: row; flex-wrap: wrap; }
    .cmd-issues { grid-column: 1 / 3; }
    .clock { font-size: 26px; }
  }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1 id="title"></h1>
      <div class="sub" id="subtitle"></div>
    </div>
    <div class="clock" id="clock">--:--:--<small>.---</small></div>
  </header>

  <div class="next" id="next"></div>

  <div class="toolbar">
    <button id="sound">🔔 Hang bekapcsolása</button>
    <label>Óra-eltérés a játékhoz: <input type="number" id="offset" step="10" value="0"> ms</label>
    <label><input type="checkbox" id="hideDone"> Kiment és elmúlt parancsok elrejtése</label>
  </div>

  <div class="issues hidden" id="general"></div>
  <div id="list"></div>

  <p class="sub">Az oldal semmit nem küld. A „Megnyitás” a játék Gyülekezőhelyét nyitja meg a célkoordinátákkal; a küldés a játékban, a te kattintásodra történik.
  Figyelmeztetés: 2 perccel és 15 másodperccel az indítás előtt. Az óra-eltérést a játék szerveridejéhez igazíthatod (pozitív érték: a játék órája siet).</p>
</main>

<script>
const DATA = ${json};
const KEY = 'terv:' + DATA.title;
const store = {
  get(k, d) { try { const v = localStorage.getItem(KEY + ':' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(KEY + ':' + k, JSON.stringify(v)); } catch {} },
};
const WARN = [120000, 15000];
const pad = (n, w = 2) => String(n).padStart(w, '0');
const hms = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
const ms3 = (d) => pad(d.getMilliseconds(), 3);
const dur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 3600) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60); };
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let offset = Number(store.get('offset', 0)) || 0;
const now = () => Date.now() + offset;
const done = new Set(store.get('done', []));
const warned = new Set();

document.getElementById('title').textContent = DATA.title;
document.title = DATA.title;
document.getElementById('subtitle').textContent =
  (DATA.world ? DATA.world.name + ' · ' : '') + DATA.commands.length + ' parancs · generálva: ' + new Date(DATA.generatedAt).toLocaleString('hu-HU');

const offsetInput = document.getElementById('offset');
offsetInput.value = offset;
offsetInput.addEventListener('input', () => { offset = Number(offsetInput.value) || 0; store.set('offset', offset); });
const hideDone = document.getElementById('hideDone');
hideDone.checked = store.get('hideDone', false);
hideDone.addEventListener('change', () => { store.set('hideDone', hideDone.checked); tick(); });

if (DATA.general.length) {
  const g = document.getElementById('general');
  g.classList.remove('hidden');
  g.innerHTML = '<b>Ellenőrzés</b><ul>' + DATA.general.map((i) => '<li class="issue-' + i.level + '">' + escH(i.text) + '</li>').join('') + '</ul>';
}

// Hang: a böngésző csak felhasználói kattintás után enged hangot
let audio = null;
document.getElementById('sound').addEventListener('click', (e) => {
  audio = audio || new (window.AudioContext || window.webkitAudioContext)();
  beep(2);
  e.target.textContent = '🔔 Hang bekapcsolva';
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
});
function beep(times) {
  if (!audio) return;
  for (let i = 0; i < times; i++) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
    const t = audio.currentTime + i * 0.25;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.start(t); o.stop(t + 0.2);
  }
}
function alertUser(text, times) {
  beep(times);
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(text); } catch {}
  flashTitle(text);
}
let flashTimer = null;
function flashTitle(text) {
  clearInterval(flashTimer);
  let n = 0;
  flashTimer = setInterval(() => { document.title = n % 2 ? DATA.title : '⏰ ' + text; if (++n > 12) { clearInterval(flashTimer); document.title = DATA.title; } }, 700);
}

// Kártyák
const list = document.getElementById('list');
const cards = DATA.commands.map((c) => {
  const card = el('section', 'cmd');
  const launch = new Date(c.launch), arrival = new Date(c.arrival);
  const tgt = c.target;
  const tgtText = '<b>' + escH(tgt.coord) + '</b>' + (tgt.label ? ' (' + escH(tgt.label) + (tgt.name && tgt.name !== tgt.label ? ': ' + escH(tgt.name) : '') + ')' : tgt.name ? ' (' + escH(tgt.name) + ')' : '');
  const owner = tgt.owner ? ' · ' + escH(tgt.owner) + (tgt.points ? ', ' + tgt.points + ' p' : '') : '';
  card.innerHTML =
    '<div class="num">#' + c.order + '</div>' +
    '<div>' +
      '<div class="when">' + hms(launch) + '<span class="ms">.' + ms3(launch) + '</span> <span class="cd-small" data-cd></span></div>' +
      '<div class="route"><b>' + escH(c.source.name) + '</b> <span class="meta">' + escH(c.source.coord) + '</span> → ' + tgtText + '<span class="meta">' + owner + '</span>' +
        '<span class="tag">' + escH(c.roleName) + (c.parts.length > 1 ? ' · ' + c.parts.length + ' rész' : '') + '</span></div>' +
      '<div class="meta" data-arrival></div>' +
      '<ul class="parts">' + c.parts.map((p, i) => '<li>' + (c.parts.length > 1 ? (p.label ? '<b>' + escH(p.label) + ':</b> ' : '<b>' + (i + 1) + '.</b> ') : '') + escH(p.units) + '</li>').join('') + '</ul>' +
      (c.catapultTarget ? '<div class="meta">katapult célpont: <b>' + escH(c.catapultTarget) + '</b></div>' : '') +
      (c.note ? '<div class="meta">' + escH(c.note) + '</div>' : '') +
    '</div>' +
    '<div class="side">' +
      (c.url ? '<a class="btn primary" target="_blank" rel="noopener" href="' + escH(c.url) + '">Megnyitás ↗</a>' : '<span class="btn" aria-disabled="true">Nincs link</span>') +
      '<label><input type="checkbox" data-done> Kiment</label>' +
    '</div>' +
    (c.issues.length ? '<ul class="cmd-issues">' + c.issues.map((i) => '<li class="issue-' + i.level + '">' + escH(i.text) + '</li>').join('') + '</ul>' : '');
  card.querySelector('[data-arrival]').textContent = 'érkezés: ' + arrival.toLocaleDateString('hu-HU') + ' ' + hms(arrival) + '.' + ms3(arrival);
  const box = card.querySelector('[data-done]');
  box.checked = done.has(c.order);
  box.addEventListener('change', () => { box.checked ? done.add(c.order) : done.delete(c.order); store.set('done', [...done]); tick(); });
  list.appendChild(card);
  return { c, card, cd: card.querySelector('[data-cd]') };
});

const nextBox = document.getElementById('next');
const clockEl = document.getElementById('clock');

function tick() {
  const t = now();
  const d = new Date(t);
  clockEl.innerHTML = hms(d) + '<small>.' + ms3(d) + '</small>';
  let next = null;
  for (const x of cards) {
    const left = x.c.launch - t;
    const isDone = done.has(x.c.order);
    x.card.classList.toggle('done', isDone);
    x.card.classList.toggle('now', !isDone && left <= 15000 && left > -10000);
    x.card.classList.toggle('soon', !isDone && left <= 120000 && left > 15000);
    x.card.classList.toggle('missed', !isDone && left <= -10000);
    x.card.classList.toggle('hidden', hideDone.checked && (isDone || left <= -10000));
    x.cd.textContent = isDone ? '✓ kiment' : left > 0 ? dur(left) + ' múlva' : left > -10000 ? 'MOST' : 'elmúlt';
    if (!isDone && left > -10000 && (!next || x.c.launch < next.c.launch)) next = x;
    for (const w of WARN) {
      const k = x.c.order + ':' + w;
      if (!isDone && left <= w && left > w - 5000 && !warned.has(k)) {
        warned.add(k);
        alertUser('#' + x.c.order + ' ' + x.c.source.name + ' → ' + x.c.target.coord + ' · ' + (w >= 60000 ? (w / 60000) + ' perc' : (w / 1000) + ' mp') + ' múlva', w >= 60000 ? 1 : 3);
      }
    }
  }
  if (next) {
    const left = next.c.launch - t;
    nextBox.innerHTML = '<span>Következő: <b>#' + next.c.order + ' ' + escH(next.c.source.name) + ' → ' + escH(next.c.target.coord) + '</b> · ' + escH(next.c.roleName) + '</span>' +
      '<span class="cd">' + (left > 0 ? dur(left) : 'MOST') + '</span>' +
      (next.c.url ? '<a class="btn primary" target="_blank" rel="noopener" href="' + escH(next.c.url) + '">Megnyitás ↗</a>' : '');
  } else {
    nextBox.innerHTML = '<span>Nincs több hátralévő parancs.</span>';
  }
}
tick();
setInterval(tick, 100);
</script>
</body>
</html>
`;
}
