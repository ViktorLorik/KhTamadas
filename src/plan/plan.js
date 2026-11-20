// Támadási terv beolvasása, eseménylistává alakítása és ellenőrzése.
// A terv csak adat: ez a modul semmilyen külső rendszerrel nem kommunikál.

import { readFileSync } from 'node:fs';
import { formatTimeMs } from '../util.js';

export const UNIT_NAMES = {
  spear: 'lándzsás', sword: 'kardforgató', axe: 'bárdos', archer: 'íjász', spy: 'kém',
  light: 'könnyűlovas', marcher: 'lovasíjász', heavy: 'nehézlovas', ram: 'kos',
  catapult: 'katapult', knight: 'lovag', snob: 'nemes',
};

export const ROLE_NAMES = {
  nuke_1: 'nuke', nuke_2: 'nuke', nuke: 'nuke',
  noble_train: 'nemesvonat', catapult_train: 'katapultvonat', fake: 'fake', support: 'támogatás',
};

export const unitsText = (units) =>
  Object.entries(units).map(([k, n]) => `${n} ${UNIT_NAMES[k] ?? k}`).join(', ');

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
      if (parts.some((p) => !p.units || typeof p.units !== 'object')) throw new Error('hiányzik a "units" (vagy a "train" elemeinél)');
      return {
        order: c.order ?? i + 1,
        role: c.role ?? 'attack',
        roleName: ROLE_NAMES[c.role] ?? c.role ?? 'parancs',
        source: { ...c.source, pos: parseCoord(c.source?.coord) },
        target: { ...c.target, pos: parseCoord(c.target?.coord) },
        slowest: c.slowest_unit ?? null,
        travelSeconds: c.travel_seconds ?? null,
        launch: parseTime(c.launch, `${where}.launch`),
        arrival: parseTime(c.arrival, `${where}.arrival`),
        catapultTarget: c.catapult_target ?? null,
        note: c.note ?? null,
        parts,
      };
    } catch (err) {
      problems.push(`${where}: ${err.message}`);
      return null;
    }
  });
  if (problems.length) throw new Error(`A terv hibás:\n  - ${problems.join('\n  - ')}`);

  commands.sort((a, b) => a.launch - b.launch || a.order - b.order);
  const targetNames = Object.fromEntries((plan.targets || []).map((t) => [t.coord, t.key ?? t.name]));
  for (const c of commands) c.target.label = targetNames[c.target.coord] ?? c.target.name ?? null;
  return { meta: plan, commands };
}

/**
 * Tartalmi ellenőrzések: a világ hivatalos adatai (ha vannak), különben a terv feltevései alapján újraszámolja a menetidőket,
 * és megnézi, összeáll-e az érkezési sorrend. Visszaad: [{ level: 'warn'|'info', text }]
 */
export function checkPlan({ meta, commands }, { now = Date.now(), world = null } = {}) {
  const issues = [];
  const add = (level, order, text) => issues.push({ level, order, text });
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
  }

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
      const d = new Date(c.arrival);
      const m = d.getHours() * 60 + d.getMinutes();
      const inside = from <= to ? m >= from && m < to : m >= from || m < to;
      if (inside) add('warn', c.order, 'éjszakai bónusz idejére érkezik');
    }
  }

  // Célpontonként: azonos másodperc, és a nukeok a nemesek előtt
  const byTarget = new Map();
  for (const c of commands) byTarget.set(c.target.coord, [...(byTarget.get(c.target.coord) ?? []), c]);
  for (const [coord, list] of byTarget) {
    const seconds = new Set(list.map((c) => Math.floor(c.arrival / 1000)));
    if (seconds.size > 1) add('warn', null, `${coord}: nem ugyanabban a másodpercben érkezik minden parancs`);
    const nukes = list.filter((c) => c.role.startsWith('nuke')).map((c) => c.arrival);
    const nobles = list.filter((c) => c.role === 'noble_train').map((c) => c.arrival);
    if (nukes.length && nobles.length && Math.max(...nukes) >= Math.min(...nobles)) {
      add('warn', null, `${coord}: egy nuke a nemesek után vagy velük egyszerre érkezik`);
    }
  }

  // Szoros indítások
  for (let i = 1; i < commands.length; i++) {
    const gap = (commands[i].launch - commands[i - 1].launch) / 1000;
    if (gap < 120) add('info', commands[i].order, `csak ${gap.toFixed(1)} mp-cel a #${commands[i - 1].order} után indul`);
  }
  return issues;
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
