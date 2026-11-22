// Támadási terv beolvasása, eseménylistává alakítása és ellenőrzése.
// A terv csak adat: ez a modul semmilyen külső rendszerrel nem kommunikál.

import { readFileSync } from 'node:fs';
import { formatDate, formatTimeMs } from '../util.js';
import { clockOffset, parseGameTime } from './clock.js';

export const UNIT_NAMES = {
  spear: 'lándzsás', sword: 'kardforgató', axe: 'bárdos', archer: 'íjász', spy: 'kém',
  light: 'könnyűlovas', marcher: 'lovasíjász', heavy: 'nehézlovas', ram: 'kos',
  catapult: 'katapult', knight: 'lovag', snob: 'nemes',
};

export const ROLE_NAMES = {
  nuke_1: 'nuke', nuke_2: 'nuke', nuke: 'nuke',
  noble_train: 'nemesvonat', noble: 'nemes', catapult_train: 'katapultvonat', fake: 'fake', support: 'támogatás',
};

export const unitsText = (units) =>
  Object.entries(units).map(([k, n]) => `${n} ${UNIT_NAMES[k] ?? k}`).join(', ');

export const roleNameOf = (role) =>
  ROLE_NAMES[role] ?? (/^nuke(_\d+)?$/.test(role ?? '') ? 'nuke' : role) ?? 'parancs';

// Az egységek alap-menetideje (perc/mező). A világ sebessége mindegyiket ugyanúgy szorozza,
// ezért a sorrendjük minden világon azonos (ehhez nem kellenek a világadatok).
export const BASE_MINUTES = { spear: 18, sword: 22, axe: 18, archer: 18, spy: 9, light: 10, marcher: 10, heavy: 11, ram: 30, catapult: 30, knight: 10, snob: 35 };
const NEVER_IN_SEND_ALL = ['snob', 'knight'];

/**
 * "Minden otthoni egység" szabály egy parancsra: a terv leglassabb egysége (slowest_unit, különben a
 * terv egységei közül a leglassabb), és az egységek, amik vele mehetnek (nemes, lovag soha; a nála
 * lassabb sem, mert az eltolná az érkezést). null, ha a parancs nem ilyen.
 */
export function sendAllRule(c) {
  if (!c.sendAll) return null;
  const planUnits = Object.keys(c.parts[0].units).filter((u) => c.parts[0].units[u] > 0);
  const slowest = (c.slowest && BASE_MINUTES[c.slowest] !== undefined ? c.slowest : null)
    ?? planUnits.filter((u) => BASE_MINUTES[u] !== undefined).sort((x, y) => BASE_MINUTES[y] - BASE_MINUTES[x])[0]
    ?? null;
  const allowed = slowest
    ? Object.keys(BASE_MINUTES).filter((u) => !NEVER_IN_SEND_ALL.includes(u) && BASE_MINUTES[u] <= BASE_MINUTES[slowest])
    : planUnits.filter((u) => !NEVER_IN_SEND_ALL.includes(u));
  return { slowest, allowed };
}

/** Egy rész egységeinek szövege; "minden egység" parancsnál a szabály, és a tervezett számok tájékoztatásul. */
export function partUnitsText(c, p) {
  const rule = sendAllRule(c);
  if (!rule) return unitsText(p.units);
  const planned = Object.fromEntries(Object.entries(p.units).filter(([, n]) => n > 0));
  const upTo = rule.slowest ? ` (${UNIT_NAMES[rule.slowest] ?? rule.slowest} sebességéig)` : '';
  return `MINDEN otthoni egység${upTo}${Object.keys(planned).length ? ` · tervezett: ${unitsText(planned)}` : ''}`;
}

export function parseCoord(text) {
  const m = /^\s*(\d{1,3})\|(\d{1,3})\s*$/.exec(String(text));
  if (!m) throw new Error(`Érvénytelen koordináta: "${text}" (formátum: 500|500)`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function parseTime(value, where) {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`${where}: érvénytelen időpont "${value}"`);
  return t;
}

/** Játékbeli időpont a tervfájlban: dátummal kell ("ma"/"holnap" egy fájlban mást jelentene holnap). */
function parseDatedTime(value, where) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(value).trim())) throw new Error(`${where}: dátummal add meg, pl. "2026-11-22 14:13:40.652" (most: "${value}")`);
  try { return parseGameTime(value); } catch (err) { throw new Error(`${where}: ${err.message}`); }
}

/** Úton lévő (már kiment) támadások, amikhez a terv igazodik: { label, target, role, gameArrival } */
function parseInFlight(list, problems) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) { problems.push('az "in_flight" tömb legyen'); return []; }
  return list.map((f, i) => {
    const where = `in_flight[${i}]`;
    try {
      parseCoord(f?.target);
      return { label: f.label ?? `úton lévő #${i + 1}`, target: String(f.target).trim(), role: f.role ?? null, gameArrival: parseDatedTime(f.game_arrival, `${where}.game_arrival`) };
    } catch (err) {
      problems.push(`${where}: ${err.message}`);
      return null;
    }
  }).filter(Boolean);
}

/** Ennél kisebb rés két érkezés között (játékidőben) már kockázatos: a kérések késése ennyit ingadozhat. */
export const MIN_SAFE_GAP_MS = 50;

/** Beolvassa és szerkezetileg ellenőrzi a tervet. Hibánál érthető üzenettel dob. */
export function loadPlan(path) {
  let plan;
  try {
    plan = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`A terv nem olvasható (${path}): ${err.message}`);
  }
  const problems = [];
  if (!Array.isArray(plan.commands) || plan.commands.length === 0) problems.push('Hiányzik a "commands" tömb');

  const commands = (plan.commands || []).map((c, i) => {
    const where = `commands[${i}]${c?.order !== undefined ? ` (#${c.order})` : ''}`;
    try {
      const parts = c.train
        ? c.train.map((p, j) => ({ index: j + 1, label: p.purpose ?? (p.noble ? `${p.noble}. nemes` : `${j + 1}. rész`), units: p.units }))
        : [{ index: 1, label: null, units: c.units }];
      if (parts.some((p) => !p.units || typeof p.units !== 'object' || Array.isArray(p.units))) throw new Error('hiányzik a "units" (vagy a "train" elemeinél)');
      for (const p of parts) {
        for (const [u, n] of Object.entries(p.units)) {
          if (BASE_MINUTES[u] === undefined) throw new Error(`ismeretlen egység: "${u}" (lehet: ${Object.keys(BASE_MINUTES).join(', ')})`);
          if (!Number.isInteger(n) || n < 0) throw new Error(`a(z) ${UNIT_NAMES[u]} száma nem nemnegatív egész: ${JSON.stringify(n)}`);
        }
      }
      if (c.send_all !== undefined && typeof c.send_all !== 'boolean') throw new Error('a "send_all" értéke true vagy false legyen');
      if (c.slowest_unit != null && BASE_MINUTES[c.slowest_unit] === undefined) throw new Error(`ismeretlen slowest_unit: "${c.slowest_unit}"`);
      return {
        order: c.order ?? i + 1,
        role: c.role ?? 'attack',
        roleName: roleNameOf(c.role),
        sendAllRequested: c.send_all === true,
        source: { ...c.source, pos: parseCoord(c.source?.coord) },
        target: { ...c.target, pos: parseCoord(c.target?.coord) },
        slowest: c.slowest_unit ?? null,
        travelSeconds: c.travel_seconds ?? null,
        launch: parseTime(c.launch, `${where}.launch`),
        arrival: parseTime(c.arrival, `${where}.arrival`),
        catapultTarget: c.catapult_target ?? null,
        // a kívánt érkezés a játék órája szerint (ha egy úton lévő támadáshoz igazítottuk) – lásd clock.js
        gameArrival: c.game_arrival != null ? parseDatedTime(c.game_arrival, `${where}.game_arrival`) : null,
        // nuke: a terv egységszámai helyett minden otthoni egység megy ("send_all": false kikapcsolja)
        sendAll: !c.train && (c.send_all ?? /^nuke/.test(c.role ?? '')),
        note: c.note ?? null,
        parts,
      };
    } catch (err) {
      problems.push(`${where}: ${err.message}`);
      return null;
    }
  });
  const seenOrders = new Map();
  for (const c of commands) {
    if (!c) continue;
    if (seenOrders.has(c.order)) problems.push(`az order ${c.order} kétszer szerepel – a napló és a riport összekeverné őket`);
    seenOrders.set(c.order, true);
  }
  const inFlight = parseInFlight(plan.in_flight, problems);
  if (problems.length) throw new Error(`A terv hibás:\n  - ${problems.join('\n  - ')}`);

  commands.sort((a, b) => a.launch - b.launch || a.order - b.order);
  const targetNames = Object.fromEntries((plan.targets || []).map((t) => [t.coord, t.key ?? t.name]));
  for (const c of commands) c.target.label = targetNames[c.target.coord] ?? c.target.name ?? null;
  return { meta: plan, commands, inFlight };
}

/**
 * Tartalmi ellenőrzések: a világ hivatalos adatai (ha vannak), különben a terv feltevései alapján újraszámolja a menetidőket,
 * és megnézi, összeáll-e az érkezési sorrend. Visszaad: [{ level: 'warn'|'info', text }]
 */
export function checkPlan({ meta, commands, inFlight = [] }, { now = Date.now(), world = null, offset: givenOffset } = {}) {
  const issues = [];
  const add = (level, order, text) => issues.push({ level, order, text });
  // Óraeltérés (clock.js): a tervezett időből játékidő. Ha nincs mérés, a kettő azonosnak számít.
  const offset = givenOffset !== undefined ? givenOffset : clockOffset(meta);
  const toGame = (t) => t + (offset?.ms ?? 0);
  if (offset) add('info', null, `óraeltérés a játékhoz: ${offset.ms > 0 ? '+' : ''}${offset.ms} ms (${offset.source}${offset.spread ? `, ingadozás ${offset.spread} ms` : ''})`);

  for (const c of commands) {
    if (c.gameArrival === null) continue;
    if (!offset) {
      add('warn', c.order, 'játékidőhöz igazított parancs (game_arrival), de nincs mért óraeltérés – mérd meg: --calibrate');
      continue;
    }
    const want = c.gameArrival - offset.ms;
    const diff = c.arrival - want;
    if (Math.abs(diff) > 1) {
      add('warn', c.order, `a játékban ${formatTimeMs(new Date(c.gameArrival))}-kor kell érkeznie, de a mostani eltéréssel (${offset.ms} ms) ${formatTimeMs(new Date(toGame(c.arrival)))}-kor ér be – helyes érkezés a tervben: ${formatTimeMs(new Date(want))}, indítás: ${formatTimeMs(new Date(c.launch - diff))} (építsd újra --game-arrival-lal)`);
    }
  }
  const assumed = meta.assumptions?.speed_seconds_per_field ?? {};
  const speeds = world?.secondsPerField ?? assumed;
  const speedSource = world ? 'a világ hivatalos egységsebességeivel' : 'a terv feltevéseivel';

  if (world) {
    for (const [unit, s] of Object.entries(assumed)) {
      const official = world.secondsPerField[unit];
      if (official !== undefined && Math.abs(official - s) > 0.001) {
        add('warn', null, `sebesség (${UNIT_NAMES[unit] ?? unit}): a tervben ${s} mp/mező, hivatalosan ${official.toFixed(3)} mp/mező`);
      }
    }
    checkVillages({ meta, commands }, world, add);
  }

  for (const c of commands) {
    const units = Object.assign({}, ...c.parts.map((p) => p.units));
    const known = Object.keys(units).filter((u) => speeds[u] !== undefined && units[u] > 0);
    const slowest = known.sort((a, b) => speeds[b] - speeds[a])[0];
    if (slowest && c.slowest && slowest !== c.slowest) add('warn', c.order, `a leglassabb egység ${UNIT_NAMES[slowest]}, nem ${UNIT_NAMES[c.slowest] ?? c.slowest}`);

    const unit = slowest ?? c.slowest;
    if (unit && speeds[unit]) {
      const computed = Math.round(distance(c.source.pos, c.target.pos) * speeds[unit]);
      c.computedTravel = computed;
      if (c.travelSeconds !== null && computed !== c.travelSeconds) {
        const realArrival = new Date(c.launch + computed * 1000);
        add('warn', c.order, `menetidő ${speedSource}: ${computed} mp (a tervben ${c.travelSeconds}) → valójában ${formatTimeMs(realArrival)}-kor érkezne; helyes indítás: ${formatTimeMs(new Date(c.arrival - computed * 1000))}`);
      }
    }
    if (c.travelSeconds !== null && Math.abs((c.arrival - c.launch) - c.travelSeconds * 1000) > 1) {
      add('warn', c.order, `indítás + menetidő ≠ érkezés (eltérés: ${((c.arrival - c.launch) / 1000 - c.travelSeconds).toFixed(3)} mp)`);
    }
    if (c.launch < now) add('info', c.order, 'az indítás ideje már elmúlt');
    if (c.catapultTarget === 'TBD') add('warn', c.order, 'a katapult célépülete nincs megadva ("TBD")');

    const rule = sendAllRule(c);
    if (rule) {
      if (!rule.slowest) add('warn', c.order, 'minden egység megy, de nincs leglassabb egység (slowest_unit) és tervezett egység sem – a menetidő nem ellenőrizhető, és bármilyen gyors egység elmehet');
      const stays = Object.keys(c.parts[0].units).filter((u) => c.parts[0].units[u] > 0 && !rule.allowed.includes(u));
      if (stays.length) add('warn', c.order, `minden egység módban ezek otthon maradnak, pedig a tervben szerepelnek: ${stays.map((u) => UNIT_NAMES[u]).join(', ')}`);
    } else {
      const total = c.parts.reduce((n, p) => n + Object.values(p.units).reduce((a, b) => a + b, 0), 0);
      if (total === 0) add('warn', c.order, 'nincs benne egység (üres "units") – így nem tud kimenni; nuke-nál hagyd el a "send_all": false-t, vagy add meg az egységeket');
    }
    if (c.sendAllRequested && c.parts.length > 1) add('warn', c.order, 'a "send_all" vonatnál (train) nem érvényes – a részek a tervezett számokkal mennek');
    if (c.role === 'noble_train') {
      c.parts.forEach((p) => { if (!(p.units.snob > 0)) add('warn', c.order, `a vonat ${p.index}. részében nincs nemes`); });
      if (c.parts.length > 1 && c.slowest && c.slowest !== 'snob') add('warn', c.order, `nemesvonat leglassabb egysége a nemes, nem ${UNIT_NAMES[c.slowest] ?? c.slowest}`);
    }
  }

  checkSameVillage(commands, add);

  // Éjszakai bónusz: a világ beállításából, különben a terv "00:00–08:00" feltevéséből
  const assumedNight = /(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/.exec(meta.assumptions?.night_bonus ?? '');
  const night = world?.night
    ? [null, world.night.start, 0, world.night.end, 0]
    : assumedNight;
  if (world?.night && assumedNight && (Number(assumedNight[1]) !== world.night.start || Number(assumedNight[3]) !== world.night.end)) {
    add('info', null, `éjszakai bónusz hivatalosan ${world.night.start}:00–${world.night.end}:00 (a tervben ${meta.assumptions.night_bonus})`);
  }
  if (night) {
    const from = Number(night[1]) * 60 + Number(night[2]);
    const to = Number(night[3]) * 60 + Number(night[4]);
    for (const c of commands) {
      const d = new Date(toGame(c.arrival));
      const m = d.getHours() * 60 + d.getMinutes();
      const inside = from <= to ? m >= from && m < to : m >= from || m < to;
      if (inside) add('warn', c.order, 'éjszakai bónusz idejére érkezik');
    }
  }

  // Célpontonként, a JÁTÉK órája szerint (tervezett érkezés + óraeltérés), az úton lévő támadásokkal együtt:
  // azonos másodperc, a nukeok a nemesek előtt, és elég rés a szomszédos érkezések között.
  const items = [
    ...commands.map((c) => ({ coord: c.target.coord, at: toGame(c.arrival), role: c.role, order: c.order, name: `#${c.order}` })),
    ...inFlight.map((f) => ({ coord: f.target, at: f.gameArrival, role: f.role ?? '', order: null, name: f.label })),
  ];
  const byTarget = new Map();
  for (const it of items) byTarget.set(it.coord, [...(byTarget.get(it.coord) ?? []), it]);
  const clockNote = offset ? ' (játékidőben)' : '';
  for (const [coord, list] of byTarget) {
    list.sort((a, b) => a.at - b.at);
    const seconds = new Set(list.map((it) => Math.floor(it.at / 1000)));
    if (seconds.size > 1) add('warn', null, `${coord}: nem ugyanabban a másodpercben érkezik minden parancs${clockNote}`);
    const nukes = list.filter((it) => it.role.startsWith('nuke'));
    const nobles = list.filter((it) => it.role === 'noble_train' || it.role === 'noble');
    if (nukes.length && nobles.length && Math.max(...nukes.map((it) => it.at)) >= Math.min(...nobles.map((it) => it.at))) {
      add('warn', null, `${coord}: egy nuke a nemesek után vagy velük egyszerre érkezik${clockNote}`);
    }
    const minGap = Math.max(MIN_SAFE_GAP_MS, offset?.spread ?? 0);
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      if (a.order === null && b.order === null) continue; // két úton lévő: azon már nem lehet változtatni
      const gap = b.at - a.at;
      if (gap < minGap) {
        add('warn', b.order ?? a.order, `${coord}: ${a.name} (${formatTimeMs(new Date(a.at))}) és ${b.name} (${formatTimeMs(new Date(b.at))}) között csak ${gap} ms${clockNote} – a sorrend felcserélődhet (biztonságos: ≥ ${minGap} ms)`);
      }
    }
  }

  // Szoros indítások
  for (let i = 1; i < commands.length; i++) {
    const gap = (commands[i].launch - commands[i - 1].launch) / 1000;
    if (gap < 120) add('info', commands[i].order, `csak ${gap.toFixed(1)} mp-cel a #${commands[i - 1].order} után indul`);
  }
  return issues;
}

/**
 * Egy faluból több parancs: a "minden egység" nuke mindent elvisz, amit enged, így ami utána indul
 * ugyanonnan és ilyen egységet kér, nem fog kimenni (hacsak közben haza nem ér valami).
 * A commands indítási sorrendben jön.
 */
function checkSameVillage(commands, add) {
  const bySource = new Map();
  for (const c of commands) bySource.set(c.source.coord, [...(bySource.get(c.source.coord) ?? []), c]);
  for (const list of bySource.values()) {
    if (list.length < 2) continue;
    list.forEach((c, i) => {
      const before = list.slice(0, i);
      const rule = sendAllRule(c);
      for (const n of before) {
        const nRule = sendAllRule(n);
        if (nRule) {
          const needs = rule
            ? rule.allowed.filter((u) => nRule.allowed.includes(u))
            : [...new Set(c.parts.flatMap((p) => Object.keys(p.units).filter((u) => p.units[u] > 0)))].filter((u) => nRule.allowed.includes(u));
          const travel = n.computedTravel ?? n.travelSeconds;
          const backAt = travel ? n.launch + 2 * travel * 1000 : null;
          if (needs.length && backAt !== null && c.launch >= backAt) {
            add('info', c.order, `ugyanebből a faluból a #${n.order} minden egységgel indul előtte, de ${formatDate(new Date(backAt))} ${formatTimeMs(new Date(backAt))}-ra (oda-vissza) a túlélők hazaérhetnek – csak azzal számolj, ami tényleg visszajön`);
          } else if (needs.length) {
            add('warn', c.order, `ugyanebből a faluból előtte indul a #${n.order} (minden egység módban), ami elviszi az otthoni ${needs.map((u) => UNIT_NAMES[u]).join(', ')} egységet – ez így nem tud kimenni, hacsak közben haza nem ér sereg`);
          }
        } else if (rule) {
          const took = Object.keys(Object.assign({}, ...n.parts.map((p) => p.units))).filter((u) => rule.allowed.includes(u) && n.parts.some((p) => p.units[u] > 0));
          if (took.length) add('info', c.order, `ugyanebből a faluból előtte indul a #${n.order}, ami elvisz ${took.map((u) => UNIT_NAMES[u]).join(', ')} egységet – ennyivel kisebb lesz ez a nuke`);
        }
      }
    });
  }
}

/** A falvak összevetése a világ nyilvános adataival; a hiányzó cél-azonosítókat/neveket kitölti. */
function checkVillages({ meta, commands }, world, add) {
  const me = meta.player ? world.player(meta.player) : null;
  const enemy = meta.enemy ? world.player(meta.enemy) : null;
  if (meta.player && !me) add('warn', null, `a "${meta.player}" játékos nem található a(z) ${world.world} világban`);
  if (meta.enemy && !enemy) add('warn', null, `a "${meta.enemy}" játékos nem található a(z) ${world.world} világban`);

  for (const c of commands) {
    const src = world.villageAt(c.source.coord);
    if (!src) add('warn', c.order, `a kiinduló falu (${c.source.coord}) nem létezik`);
    else {
      if (me && src.owner?.id !== me.id) add('warn', c.order, `a kiinduló falu (${c.source.coord}) tulajdonosa ${src.owner?.name ?? 'barbár'}, nem ${me.name}`);
      if (c.source.id && c.source.id !== src.id) add('warn', c.order, `a kiinduló falu azonosítója ${src.id}, a tervben ${c.source.id}`);
    }
    const tgt = world.villageAt(c.target.coord);
    if (!tgt) { add('warn', c.order, `a célfalu (${c.target.coord}) nem létezik`); continue; }
    c.target.world = tgt;
    if (c.target.id && c.target.id !== tgt.id) add('warn', c.order, `a célfalu azonosítója ${tgt.id}, a tervben ${c.target.id}`);
    if (enemy && tgt.owner?.id !== enemy.id) add('warn', c.order, `a célfalu (${c.target.coord}) tulajdonosa ${tgt.owner?.name ?? 'barbár'}, nem ${enemy.name}`);
    if (me && tgt.owner?.id === me.id) add('warn', c.order, `a célfalu (${c.target.coord}) már a tiéd`);
  }
}
