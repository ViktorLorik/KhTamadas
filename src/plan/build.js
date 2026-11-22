// Parancsépítők: a Tampermonkey-gombok (Nemesvonat, Fake, Gyors 4x) logikája, plusz a "minden egység" nuke,
// beépítve az alkalmazásba. A kimenet közvetlenül a terv "commands" tömbjébe illeszthető.
// Semmilyen külső rendszerrel nem kommunikál – csak a terv JSON-t alkotja.

import { distance, parseCoord, BASE_MINUTES, UNIT_NAMES } from './plan.js';

/** Időpont a gép helyi idejével és eltolásával, ms-ra: "2026-11-22T14:13:40.700+01:00" (ahogy a tervekben). */
export function isoLocal(ms) {
  const d = new Date(ms);
  const pad = (n, l = 2) => String(Math.abs(n)).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    + `${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

function arrivalMs(arrival) {
  const t = typeof arrival === 'number' ? arrival : Date.parse(arrival);
  if (Number.isNaN(t)) throw new Error(`Érvénytelen érkezési idő: "${arrival}"`);
  return t;
}

function checkUnits(units, what) {
  if (!units || typeof units !== 'object' || Array.isArray(units)) throw new Error(`${what}: egység-objektum kell, pl. {"axe":6000,"ram":300}`);
  const out = {};
  for (const [u, n] of Object.entries(units)) {
    if (BASE_MINUTES[u] === undefined) throw new Error(`${what}: ismeretlen egység "${u}" (lehet: ${Object.keys(BASE_MINUTES).join(', ')})`);
    if (!Number.isInteger(Number(n)) || Number(n) < 0) throw new Error(`${what}: a(z) ${UNIT_NAMES[u]} száma nem nemnegatív egész (${n})`);
    if (Number(n) > 0) out[u] = Number(n);
  }
  return out;
}

/**
 * A leglassabb egység a megadottak közül. A sorrend minden világon azonos (BASE_MINUTES), így csak
 * ennek az egy egységnek kell a sebessége; a kos és a katapult egyforma, ilyenkor a kos.
 */
function slowestOf(units) {
  const list = Object.keys(units).filter((u) => units[u] > 0);
  return list.sort((a, b) => BASE_MINUTES[b] - BASE_MINUTES[a] || (a === 'ram' ? -1 : b === 'ram' ? 1 : 0))[0] ?? null;
}

/** Menetidő (mp) és indítás: a játék a menetidőt egész másodpercre kerekíti. */
function timing({ source, target, unit, speeds, arrival }) {
  if (!unit || !speeds[unit]) throw new Error(`A menetidőhöz kell a(z) ${UNIT_NAMES[unit] ?? unit ?? '?'} mp/mező értéke (speeds).`);
  if (source === target) throw new Error('A kiinduló és a célfalu ugyanaz.');
  const travel = Math.round(distance(parseCoord(source), parseCoord(target)) * speeds[unit]);
  const arr = arrivalMs(arrival);
  return { slowest_unit: unit, travel_seconds: travel, arrival: isoLocal(arr), launch: isoLocal(arr - travel * 1000) };
}

/**
 * Nemesvonat: 4 támadás egymás után, a lehető leggyorsabban, az első mindig elsőként megy ki.
 *   1. rész: a teljes sereg − 3 nemes − 300 bárdos
 *   2–4. rész: 1 nemes + 100 bárdos
 * @param {object} p
 * @param {object} p.units       a kiinduló faluban elérhető összes egység ({ axe: 6209, snob: 4, ... })
 * @param {string} p.source      "530|550"
 * @param {string} p.target      "508|574"
 * @param {string|number} p.arrival érkezési idő (ISO vagy epoch ms) – a vonat ebben a pillanatban érkezik
 * @param {object} p.speeds      mp/mező értékek ({ snob: 1944.444, ram: 1666.667, ... } a világból vagy a terv feltevéseiből)
 * @param {string} [p.label]     a részcímkékhez
 */
export function buildNobleTrain({ units, source, target, arrival, speeds, label = null }) {
  const have = checkUnits(units, 'Nemesvonat');
  const snob = have.snob ?? 0;
  const axe = have.axe ?? 0;
  if (snob < 4) throw new Error(`Nemesvonathoz legalább 4 nemes kell a faluban (most: ${snob}).`);
  if (axe < 300 + 3 * 100) throw new Error(`Nemesvonathoz legalább ${300 + 3 * 100} bárdos kell (1. rész −300, 3 kisérő ×100; most: ${axe}).`);

  const first = { ...have, axe: axe - 300, snob: snob - 3 };
  if (!first.axe) delete first.axe;
  const train = [
    { noble: 1, units: first, ...(label ? { purpose: `${label} · teljes sereg` } : {}) },
    { noble: 2, units: { snob: 1, axe: 100 } },
    { noble: 3, units: { snob: 1, axe: 100 } },
    { noble: 4, units: { snob: 1, axe: 100 } },
  ];
  // A vonat minden része nemest visz, ezért a nemes sebessége szab (a lovag sem lassabb nála).
  return {
    role: 'noble_train',
    source: { coord: source },
    target: { coord: target },
    train,
    ...timing({ source, target, unit: slowestOf(first), speeds, arrival }),
  };
}

/**
 * Nuke: alapból "minden otthoni egység" – az indításkor otthon lévő sereg megy, a leglassabb egység
 * (alapból kos) sebességéig; a nemes és a lovag otthon marad. Ha a units is meg van adva, az csak
 * tájékoztató (a terv ellenőrzése és a napló ezt mutatja), kivéve sendAll: false-nál, amikor pontosan az megy.
 */
export function buildNuke({ source, target, arrival, speeds, slowest = null, units = {}, sendAll = true, role = 'nuke_1' }) {
  const planned = checkUnits(units, 'Nuke');
  if (!sendAll && !Object.keys(planned).length) throw new Error('Nuke "send_all": false mellett meg kell adni az egységeket (--units).');
  // A nemes és a lovag minden egység módban otthon marad, így a leglassabbat nélkülük keressük.
  const moving = sendAll ? Object.fromEntries(Object.entries(planned).filter(([u]) => u !== 'snob' && u !== 'knight')) : planned;
  const unit = slowest ?? slowestOf(moving) ?? 'ram';
  if (BASE_MINUTES[unit] === undefined) throw new Error(`Ismeretlen leglassabb egység: "${unit}"`);
  if (unit === 'snob' || unit === 'knight') throw new Error('Nuke leglassabb egysége nem lehet nemes vagy lovag (azok minden egység módban otthon maradnak).');
  const tooSlow = Object.keys(moving).filter((u) => BASE_MINUTES[u] > BASE_MINUTES[unit]);
  if (tooSlow.length) throw new Error(`A tervezett egységek közt lassabb is van, mint a(z) ${UNIT_NAMES[unit]}: ${tooSlow.map((u) => UNIT_NAMES[u]).join(', ')}`);
  return {
    role,
    source: { coord: source },
    target: { coord: target },
    send_all: sendAll,
    units: planned,
    ...timing({ source, target, unit, speeds, arrival }),
  };
}

/**
 * Fake szóró: egy látszat-támadás minimális egységgel (alap 1 bárdos; katapulttal ha meg van adva).
 * Ugyanúgy "attack"-ként megy ki, mint egy nuke – a védelem számára ijesztő.
 */
export function buildFake({ source, target, unit = 'axe', count = 1, arrival, speeds }) {
  const units = checkUnits({ [unit]: count }, 'Fake');
  if (!Object.keys(units).length) throw new Error('Fake: legalább 1 egység kell.');
  return {
    role: 'fake',
    source: { coord: source },
    target: { coord: target },
    send_all: false,
    units,
    ...timing({ source, target, unit, speeds, arrival }),
  };
}

/**
 * Gyors 4x: ugyanaz a parancs 4-szer, másodperces különbségekkel érkezve.
 * Mind a 4 a megadott számokkal megy ("send_all": false) – különben az első elvinné az egész sereget.
 */
export function buildQuad({ units, source, target, arrival, speeds, role = 'nuke_1', gapSec = 2 }) {
  const planned = checkUnits(units, 'Gyors 4x');
  if (!Object.keys(planned).length) throw new Error('Gyors 4x: add meg az egységeket (--units).');
  const unit = slowestOf(planned);
  const arr = arrivalMs(arrival);
  const base = role.replace(/_\d+$/, '');
  return [1, 2, 3, 4].map((i) => ({
    role: `${base}_${i}`,
    source: { coord: source },
    target: { coord: target },
    send_all: false,
    units: planned,
    ...timing({ source, target, unit, speeds, arrival: arr + (i - 1) * gapSec * 1000 }),
  }));
}

/**
 * Az épített parancsok kiegészítése a nyilvános világadatokból (falu-azonosító és név), ha elérhetők.
 * Hiba, ha a koordinátán nincs falu.
 */
export function enrichFromWorld(commands, world) {
  if (!world) return [];
  const notes = [];
  for (const c of commands) {
    for (const side of ['source', 'target']) {
      const v = world.villageAt(c[side].coord);
      if (!v) throw new Error(`A(z) ${c[side].coord} koordinátán nincs falu a(z) ${world.world} világban.`);
      c[side] = { name: v.name, id: v.id, coord: v.coord };
      if (side === 'target') notes.push(`${v.coord}: ${v.name} – ${v.owner?.name ?? 'barbár'}, ${v.points} p`);
    }
  }
  return notes;
}

/**
 * Parancsok beillesztése egy meglévő terv JSON-ba: order sorszámot kapnak (a legnagyobb után),
 * és a "commands" indítási sorrendbe kerül. Visszaadja az új terv objektumot (a fájlt nem írja).
 */
export function mergeIntoPlan(plan, commands) {
  const existing = Array.isArray(plan.commands) ? plan.commands : [];
  let next = existing.reduce((m, c) => Math.max(m, Number(c.order) || 0), 0);
  const added = commands.map((c) => ({ order: ++next, ...c }));
  const all = [...existing, ...added].sort((a, b) => Date.parse(a.launch) - Date.parse(b.launch) || a.order - b.order);
  return { plan: { ...plan, commands: all }, added };
}
