// Parancsépítők: a Tampermonkey-gombok (Nemesvonat, Fake, Gyors 4x) logikája,
// beépítve az alkalmazásba. A kimenet közvetlenül a terv "commands" tömbjébe illeszthető.
// Semmilyen külső rendszerrel nem kommunikál – csak a terv JSON-t alkotja.

import { distance, parseCoord } from './plan.js';

/**
 * Nemesvonat: 4 támadás egymás után, a lehető leggyorsabban, az első mindig elsőként megy ki.
 *   1. rész: a teljes sereg − 3 nemes − 300 bárdos
 *   2–4. rész: 1 nemes + 100 bárdos
 * @param {object} p
 * @param {object} p.units       a kiinduló faluban elérhető összes egység ({ axe: 6209, snob: 4, ... })
 * @param {string} p.source      "530|550"
 * @param {string} p.target      "508|574"
 * @param {string|number} p.arrival érkezési idő (ISO vagy epoch ms) – a vonat ebben a másodpercben érkezik
 * @param {object} p.speeds      mp/mező értékek ({ snob: 1944.444, ram: 1666.667, ... } a világból vagy a terv feltevéseiből)
 * @param {string} [p.label]     a részcímkékhez
 * @param {number} [p.gapMs]     a vonatrészek érkezési rése (alap 500 ms, ahogy a példatervben)
 */
export function buildNobleTrain({ units, source, target, arrival, speeds, label = null, gapMs = 500 }) {
  const have = { ...units };
  const snob = Number(have.snob ?? 0);
  const axe = Number(have.axe ?? 0);
  if (snob < 4) throw new Error(`Nemesvonathoz legalább 4 nemes kell a faluban (most: ${snob}).`);
  if (axe < 300 + 3 * 100) throw new Error(`Nemesvonathoz legalább ${300 + 3 * 100} bárdos kell (1. rész −300, 3 kisérő ×100; most: ${axe}).`);

  const first = {};
  for (const [u, n] of Object.entries(have)) {
    if (u === 'snob') continue;
    if (Number(n) > 0) first[u] = Number(n);
  }
  first.axe -= 300;
  first.snob = snob - 3;

  const train = [
    { noble: 1, units: first, ...(label ? { purpose: `${label} · teljes sereg` } : {}) },
    { noble: 2, units: { snob: 1, axe: 100 } },
    { noble: 3, units: { snob: 1, axe: 100 } },
    { noble: 4, units: { snob: 1, axe: 100 } },
  ];

  const slowest = train[0].units;
  const unit = Object.keys(slowest).sort((a, b) => (speeds[b] ?? 0) - (speeds[a] ?? 0))[0];
  if (!unit || !speeds[unit]) throw new Error('A menetidőhöz kell a leglassabb egység mp/mező értéke (speeds).');
  const travel = Math.round(distance(parseCoord(source), parseCoord(target)) * speeds[unit]);

  return {
    role: 'noble_train',
    source: { coord: source },
    target: { coord: target },
    train,
    slowest_unit: unit,
    travel_seconds: travel,
    arrival: new Date(arrival).toISOString(),
    launch: new Date(new Date(arrival).getTime() - travel * 1000).toISOString(),
    _train_gap_ms: gapMs, // a részek érkezési ideje: arrival + (i-1)*gapMs
  };
}

/**
 * Fake szóró: egy látszat-támadás minimális egységgel (alap 1 bárdos; katapulttal ha meg van adva).
 * Ugyanúgy "attack"-ként megy ki, mint egy nuke – a védelem számára ijesztő.
 */
export function buildFake({ source, target, unit = 'axe', count = 1, arrival, speeds }) {
  if (!speeds[unit]) throw new Error(`A fake-hez ismeretlen vagy hiányzó egységsebesség: "${unit}".`);
  const travel = Math.round(distance(parseCoord(source), parseCoord(target)) * speeds[unit]);
  return {
    role: 'fake',
    source: { coord: source },
    target: { coord: target },
    units: { [unit]: count },
    slowest_unit: unit,
    travel_seconds: travel,
    arrival: new Date(arrival).toISOString(),
    launch: new Date(new Date(arrival).getTime() - travel * 1000).toISOString(),
  };
}

/**
 * Gyors 4x: ugyanaz a parancs 4-szer, egymás után minél hamarabb.
 * A tervben 4 külön parancsként szerepel, másodperces különbségekkel.
 */
export function buildQuad({ units, source, target, arrival, speeds, role = 'nuke_1', gapSec = 2 }) {
  const unit = Object.entries(units).filter(([, n]) => n > 0).sort((a, b) => (speeds[b[0]] ?? 0) - (speeds[a[0]] ?? 0))[0]?.[0];
  if (!unit || !speeds[unit]) throw new Error('A menetidőhöz kell a leglassabb egység mp/mező értéke (speeds).');
  const travel = Math.round(distance(parseCoord(source), parseCoord(target)) * speeds[unit]);
  const arr = new Date(arrival).getTime();
  return [1, 2, 3, 4].map((i) => ({
    role: i === 1 ? role : `${role.replace(/_\d+$/, '')}_${i}`,
    source: { coord: source },
    target: { coord: target },
    units,
    slowest_unit: unit,
    travel_seconds: travel,
    arrival: new Date(arr + (i - 1) * gapSec * 1000).toISOString(),
    launch: new Date(arr + (i - 1) * gapSec * 1000 - travel * 1000).toISOString(),
  }));
}
