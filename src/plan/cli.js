// Tervszimulátor: a terv minden indítását ezredmásodperc-pontosan "lejátssza".
// Alapból szimuláció: az indítás pillanatában naplóz ("itt ment volna ki").
// A --send <session.json> kapcsolóval élesben is kiküldi a támadásokat
// (a munkamenetet egyszer a böngészőből kell kimenteni – lásd session.example.json).
//
//   node src/index.js --plan tervek/terv.json                    szimuláció (naplózás)
//   node src/index.js --plan tervek/terv.json --send session.json   ÉLES KÜLDÉS (csak valós időben!)
//   node src/index.js --plan tervek/terv.json --check            csak ellenőrzés + menetrend
//   node src/index.js --plan tervek/terv.json --shift 10s        eltolva: az első indítás 10 mp múlva
//   node src/index.js --plan tervek/terv.json --speed 60         60× gyorsítva (a pontosság valós ms-ban mérve)
//   ... --notify          Windows-értesítés figyelmeztetéskor és indításkor
//   ... --warn 2m,15s     előfigyelmeztetések (alapból 2m,15s; "none" = nincs)
//   ... --prepare 5s      éles küldésnél: ennyivel az indítás előtt töltse le a megerősítő űrlapokat
//   ... --attack-label "Támadás"  a Gyülekezőhely "Támadás" gombjának felirata
//
// Parancsépítők (Tampermonkey-gombok helyett):
//   node src/index.js --build noble_train --source "530|550" --target "508|574"
//       --arrival 2026-11-21T08:45:01+01:00 --units '{"axe":6209,"snob":4,"light":2734}'
//   node src/index.js --build nuke --source ... --target ... --arrival ... [--slowest ram]
//       [--units '{"axe":6000,"ram":300}' – csak tájékoztató] [--exact – pontosan a --units megy]
//   node src/index.js --build fake  ... --units '{"unit":"ram","count":1}'
//   node src/index.js --build quad  ... --units '{"axe":100,"ram":10}'
//   közös: [--server https://hu103.klanhaboru.hu/game.php | --plan terv.json] (sebességek, falunevek)
//          [--into tervek/terv.json – beírja a tervbe, sorszámmal, ellenőrizve] [--out resz.json] [--role nuke_2]

import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createLogger, paint, C } from '../logger.js';
import { formatClock, formatDate, formatTimeMs, parseDuration } from '../util.js';
import { loadPlan, checkPlan, unitsText, partUnitsText, sendAllRule, UNIT_NAMES, MIN_SAFE_GAP_MS } from './plan.js';
import { clockOffset, parseGameTime, addCalibrationSample, CALIBRATION_FILE } from './clock.js';
import { createClock, waitUntil } from './precise.js';
import { notify } from './notify.js';
import { loadWorld } from './world.js';
import { buildDashboardData, renderDashboard } from './html.js';
import { createSender, loadSession, SenderError, allUnits, unitShortage } from './sender.js';
import { buildNobleTrain, buildFake, buildQuad, buildNuke, enrichFromWorld, mergeIntoPlan, isoLocal } from './build.js';

function printVillages(log, world, name) {
  if (!world) { log.error('A falulistához a világ adatai kellenek (a terv "server" mezője, --offline nélkül).'); return 1; }
  const player = name ? world.player(name) : null;
  if (!player) { log.error(`Nincs ilyen játékos: "${name}"`); return 1; }
  const list = world.villagesOf(player).sort((a, b) => a.name.localeCompare(b.name, 'hu'));
  const ally = player.ally ? ` · klán: ${player.ally.name} [${player.ally.tag}]` : '';
  log.title(`${player.name} – ${list.length} falu, ${player.points.toLocaleString('hu-HU')} pont, ${player.rank}. hely${ally}`);
  for (const v of list) log.info(`  ${v.coord.padEnd(8)} ${String(v.points).padStart(6)} p   #${String(v.id).padEnd(5)} ${v.name}`);
  return 0;
}

function parseArgs(argv) {
  const o = {
    plan: null, check: false, shift: null, speed: 1, notify: false, warn: '2m,15s', offline: false, refresh: false,
    villages: null, html: null, send: null, attackLabel: 'Támadás', prepareMs: 5000,
    build: null, source: null, target: null, arrival: null, units: null, out: null,
    server: null, slowest: null, into: null, role: null, exact: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`A(z) ${a} után érték kell`);
      return v;
    };
    if (a === '--plan' || a === '-p') o.plan = next();
    else if (a === '--check' || a === '-c') o.check = true;
    else if (a === '--shift') o.shift = parseDuration(next());
    else if (a === '--speed') o.speed = Number(next());
    else if (a === '--notify') o.notify = true;
    else if (a === '--warn') o.warn = next();
    else if (a === '--offline') o.offline = true;
    else if (a === '--refresh') o.refresh = true;
    else if (a === '--html') o.html = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '';
    else if (a === '--villages') o.villages = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '';
    else if (a === '--send') o.send = next();
    else if (a === '--attack-label') o.attackLabel = next();
    else if (a === '--prepare') o.prepareMs = parseDuration(next());
    else if (a === '--build') o.build = next();
    else if (a === '--source') o.source = next();
    else if (a === '--target') o.target = next();
    else if (a === '--arrival') o.arrival = next();
    else if (a === '--units') o.units = next();
    else if (a === '--out') o.out = next();
    else if (a === '--server') o.server = next();
    else if (a === '--slowest') o.slowest = next();
    else if (a === '--into') o.into = next();
    else if (a === '--role') o.role = next();
    else if (a === '--exact') o.exact = true;
    else if (a === '--game-arrival') o.gameArrival = next();
    else if (a === '--between') o.between = next();
    else if (a === '--calibrate') o.calibrate = Number(next());
    else if (a === '--part') o.part = Number(next());
    else throw new Error(`Ismeretlen kapcsoló terv módban: ${a}`);
  }
  if (o.calibrate !== undefined) {
    if (!Number.isInteger(o.calibrate)) throw new Error('--calibrate: a parancs sorszáma (order) kell, pl. --calibrate 3');
    if (!o.gameArrival) throw new Error('--calibrate mellé kell: --game-arrival "<a játékban látott érkezés, pl. ma 14:13:40:728>"');
  }
  if (o.build) {
    const required = ['source', 'target', ...(o.build === 'nuke' && !o.exact ? [] : ['units'])];
    for (const k of required) {
      if (!o[k]) throw new Error(`A --build-hez kell: --${k}`);
    }
    const timeGiven = [o.arrival, o.gameArrival, o.between].filter(Boolean).length;
    if (timeGiven !== 1) throw new Error('A --build-hez pontosan egy kell ezek közül: --arrival (a terv órája szerint), --game-arrival (a játék órája szerint), --between "<játékidő A>,<játékidő B>"');
    o.source = o.source.trim(); o.target = o.target.trim();
    if (o.arrival) {
      if (Number.isNaN(Date.parse(o.arrival))) throw new Error(`--arrival: érvénytelen időpont "${o.arrival}"`);
      if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(o.arrival.trim())) o.arrivalNote = 'az --arrival-ban nincs időzóna – a gép helyi idejeként értem';
    }
    if (o.units) {
      try { o.units = JSON.parse(o.units); } catch { throw new Error('--units: JSON kell, pl. \'{"axe":6209,"snob":4}\''); }
    }
    if (o.into && o.out) throw new Error('A --into és az --out közül csak az egyiket add meg.');
    return o;
  }
  if (!o.plan) throw new Error('Add meg a tervet: --plan <fájl>');
  if (!(o.speed > 0) || o.speed > 10_000) throw new Error('A --speed 0 és 10000 közötti szám legyen');
  if (o.send && (o.shift !== null || o.speed !== 1)) throw new Error('Éles küldés (--send) csak valós időben mehet: --shift és --speed tiltott mellé.');
  o.warnings = o.warn === 'none' ? [] : o.warn.split(',').map((w) => parseDuration(w.trim())).sort((a, b) => b - a);
  return o;
}

/** Parancsépítők futtatása: a kész parancs(ok) JSON-ban a kimenetre (vagy --out fájlba). */
async function runBuild(opts, log) {
  // Sebességek és falunevek: --server, különben a --into / --plan terv "server" mezője, végül a terv feltevései.
  const planFile = opts.into ?? opts.plan;
  let rawPlan = null;
  if (planFile) {
    const p = resolve(planFile);
    if (!existsSync(p)) throw new Error(`A terv nem található: ${p}`);
    try { rawPlan = JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (err) { throw new Error(`A terv nem olvasható (${p}): ${err.message}`); }
  }
  const server = opts.server ?? rawPlan?.server ?? null;
  let world = null;
  if (server) {
    try { world = await loadWorld(server, { log }); } catch (err) { log.warn(`  ! A világadatok nem érhetők el (${err.message}) – a terv feltevéseivel számolok.`); }
  }
  const speeds = world?.secondsPerField ?? rawPlan?.assumptions?.speed_seconds_per_field ?? null;
  if (!speeds) throw new Error('A menetidőhöz kellenek az egységsebességek: adj meg --server-t, vagy --plan/--into tervet "server" mezővel vagy "assumptions.speed_seconds_per_field"-del.');
  if (!world) log.detail(`  Sebességek a terv feltevéseiből: ${Object.entries(speeds).map(([u, s]) => `${UNIT_NAMES[u] ?? u} ${s}`).join(', ')} mp/mező`);
  if (opts.arrivalNote) log.warn(`  ! ${opts.arrivalNote}`);

  // Játékidőhöz igazítás: a kívánt játékbeli érkezésből a mért óraeltéréssel lesz tervezett érkezés.
  let arrival = opts.arrival;
  let anchors = [];
  const offset = clockOffset(rawPlan);
  if (opts.gameArrival || opts.between) {
    if (!offset) throw new Error('Játékidőhöz igazításhoz mért óraeltérés kell. Egy már kiment parancsnál nézd meg a játékban az érkezést, és add meg: start.cmd --plan <terv> --calibrate <order> --game-arrival "ma 14:13:40:728"');
    let gameArrival;
    if (opts.between) {
      const parts = opts.between.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length !== 2) throw new Error('--between: két játékbeli időpont kell vesszővel, pl. "ma 14:13:40:652,ma 14:13:40:804"');
      const [a, b] = parts.map((s) => parseGameTime(s));
      if (!(b > a)) throw new Error('--between: a második időpont legyen a későbbi');
      gameArrival = Math.round((a + b) / 2);
      const half = Math.floor((b - a) / 2);
      const safe = Math.max(MIN_SAFE_GAP_MS, offset.spread ?? 0);
      if (half < safe) log.warn(`  ! A rés túl szűk: mindkét oldaltól csak ${half} ms (biztonságos: ≥ ${safe} ms) – a sorrend felcserélődhet.`);
      anchors = [a, b];
    } else {
      gameArrival = parseGameTime(opts.gameArrival);
    }
    arrival = gameArrival - offset.ms;
    log.detail(`  Játékbeli érkezés ${formatDate(new Date(gameArrival))} ${formatTimeMs(new Date(gameArrival))} − óraeltérés (${offset.ms} ms, ${offset.source}) → a tervben ${formatTimeMs(new Date(arrival))}`);
  }
  const common = { source: opts.source, target: opts.target, arrival, speeds };
  const units = opts.units ?? {};
  let commands;
  if (opts.build === 'noble_train') commands = [buildNobleTrain({ ...common, units })];
  else if (opts.build === 'nuke') commands = [buildNuke({ ...common, units, slowest: opts.slowest, sendAll: !opts.exact, role: opts.role ?? 'nuke_1' })];
  else if (opts.build === 'fake') commands = [buildFake({ ...common, unit: units.unit ?? 'axe', count: units.count ?? 1 })];
  else if (opts.build === 'quad') commands = buildQuad({ ...common, units, role: opts.role ?? 'nuke_1' });
  else throw new Error(`Ismeretlen építő: "${opts.build}" (noble_train | nuke | fake | quad)`);
  for (const n of enrichFromWorld(commands, world)) log.detail(`  Cél: ${n}`);
  if (opts.gameArrival || opts.between) {
    for (const c of commands) c.game_arrival = isoLocal(Date.parse(c.arrival) + offset.ms);
  }

  if (opts.into) {
    const target = resolve(opts.into);
    const { plan: merged, added } = mergeIntoPlan(rawPlan, commands);
    // A --between két időpontja úton lévő támadás: bekerül az "in_flight"-ba, hogy az ellenőrzés később is lássa.
    if (anchors.length) {
      const list = Array.isArray(merged.in_flight) ? [...merged.in_flight] : [];
      const target = commands[0].target.coord;
      anchors.forEach((t, i) => {
        const game = isoLocal(t);
        if (list.some((f) => f.target === target && Date.parse(f.game_arrival) === t)) return;
        list.push({ label: `úton lévő (#${added[0].order} ${i === 0 ? 'előtte' : 'utána'})`, target, role: null, game_arrival: game });
      });
      merged.in_flight = list;
    }
    const tmp = `${target}.uj.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    let checked;
    try {
      checked = loadPlan(tmp);
    } catch (err) {
      unlinkSync(tmp);
      throw new Error(`A bővített terv nem lenne érvényes, nem írtam bele:\n${err.message}`);
    }
    copyFileSync(target, `${target}.bak`);
    renameSync(tmp, target);
    log.ok(`✓ ${added.length} parancs beírva: ${target} (#${added.map((c) => c.order).join(', #')}) · előző változat: ${basename(target)}.bak`);
    for (const c of added) log.detail(`  #${c.order} ${c.role}${c.send_all ? ' (minden egység)' : ''}: indul ${c.launch} · érkezik ${c.arrival} · menetidő ${formatClock(c.travel_seconds)} (${UNIT_NAMES[c.slowest_unit]})`);
    log.title('Ellenőrzés');
    printIssues(log, checkPlan(checked, { world }));
    return 0;
  }

  const text = JSON.stringify(commands.length === 1 ? commands[0] : commands, null, 2);
  if (opts.out) {
    writeFileSync(resolve(opts.out), text, 'utf8');
    log.ok(`✓ Parancs elkészült: ${resolve(opts.out)}`);
    log.detail('  Másold be a terv "commands" tömbjébe (vagy használd a --into <terv.json> kapcsolót, az sorszámot is ad).');
  } else {
    console.log(text);
  }
  return 0;
}

/**
 * Óraeltérés mérése: a parancs tervezett érkezése és a játékban látott érkezése közti különbség.
 * A vonat részei a tervben azonos érkezésűek, de egymás után, néhány ms-mal később mennek ki:
 * a mérés az 1. részre a legpontosabb (--part n mással is mehet, a napló jelzi).
 */
function runCalibrate(opts, { meta, commands }, planPath, log) {
  const c = commands.find((x) => x.order === opts.calibrate);
  if (!c) throw new Error(`Nincs #${opts.calibrate} parancs a tervben.`);
  const part = opts.part ?? 1;
  if (!c.parts[part - 1]) throw new Error(`A #${c.order} parancsnak nincs ${part}. része.`);
  const game = parseGameTime(opts.gameArrival);
  const offsetMs = game - c.arrival;
  if (Math.abs(offsetMs) > 5000) {
    throw new Error(`A különbség ${offsetMs} ms – ez nem óraeltérés, valószínűleg rossz a nap vagy a parancs (terv: ${formatDate(new Date(c.arrival))} ${formatTimeMs(new Date(c.arrival))}, játék: ${formatDate(new Date(game))} ${formatTimeMs(new Date(game))}).`);
  }
  const before = clockOffset(null);
  const after = addCalibrationSample({
    offsetMs, at: new Date().toISOString(), plan: basename(planPath), order: c.order, part,
    planned: isoLocal(c.arrival), game: isoLocal(game),
  });
  log.ok(`✓ Mérés: #${c.order}${c.parts.length > 1 ? ` ${part}. rész` : ''} – terv ${formatTimeMs(new Date(c.arrival))}, játék ${formatTimeMs(new Date(game))} → ${offsetMs > 0 ? '+' : ''}${offsetMs} ms`);
  if (part > 1) log.detail('  (vonat későbbi része: a részek néhány ms-mal egymás után mennek ki, ez a mérésben is benne van)');
  log.info(`  Érvényes óraeltérés: ${after.ms} ms (${after.source}${after.spread ? `, ingadozás ${after.spread} ms` : ''})${before ? ` – előtte ${before.ms} ms` : ''}`);
  log.detail(`  Mentve: ${CALIBRATION_FILE}`);
  if (meta.assumptions?.clock_offset_ms != null) log.warn(`  ! Ebben a tervben fix "clock_offset_ms" van (${meta.assumptions.clock_offset_ms}), az erősebb a mérésnél.`);
  return 0;
}

/** Élő, egysoros visszaszámláló (csak terminálban). */
function createStatusLine() {
  const tty = process.stdout.isTTY;
  let shown = false;
  return {
    set(text) {
      if (!tty) return;
      process.stdout.write(`\r\x1b[2K${paint(C.dim, text)}`);
      shown = true;
    },
    clear() {
      if (tty && shown) process.stdout.write('\r\x1b[2K');
      shown = false;
    },
  };
}

function printSchedule(log, commands) {
  log.title(`Menetrend – ${commands.length} parancs, ${commands.reduce((n, c) => n + c.parts.length, 0)} indítás`);
  for (const c of commands) {
    const tw = c.target.world;
    const owner = tw ? ` – ${tw.owner?.name ?? 'barbár'}, ${tw.points} p` : '';
    const target = `${c.target.coord}${c.target.label ? ` (${c.target.label}${tw && tw.name !== c.target.label ? `: ${tw.name}` : ''})` : tw ? ` (${tw.name})` : ''}${owner}`;
    const parts = c.parts.length > 1 ? ` · ${c.parts.length} rész` : sendAllRule(c) ? ' · minden egység' : '';
    log.info(`  #${String(c.order).padStart(2)}  ${formatDate(new Date(c.launch))} ${formatTimeMs(new Date(c.launch))}  ${c.source.name ?? c.source.coord} → ${target}  ${c.roleName}${parts}  · érk. ${formatTimeMs(new Date(c.arrival))}`);
  }
}

function printIssues(log, issues) {
  if (!issues.length) { log.ok('✓ A terv belsőleg következetes (menetidők, érkezési sorrend rendben).'); return; }
  for (const i of issues) {
    const where = i.order !== null ? `#${i.order}: ` : '';
    if (i.level === 'warn') log.warn(`  ! ${where}${i.text}`); else log.detail(`  · ${where}${i.text}`);
  }
}

// Az egységek alap-menetideje (perc/mező). A világ sebessége mindegyiket ugyanúgy szorozza,
// ezért a sorrendjük minden világon azonos: ehhez nem kellenek a világadatok.
const BASE_MINUTES = { spear: 18, sword: 22, axe: 18, archer: 18, spy: 9, light: 10, marcher: 10, heavy: 11, ram: 30, catapult: 30, knight: 10, snob: 35 };

/**
 * Nuke "mindent küld" beállítása: mely egységek mehetnek, és melyik a terv leglassabb egysége.
 * A nemes és a lovag nem megy; a terv leglassabb egységénél lassabb sem (az eltolná az érkezést).
 */
function sendAllOptions(c) {
  if (!c.sendAll) return null;
  const planUnits = Object.keys(c.parts[0].units).filter((u) => c.parts[0].units[u] > 0);
  const slowest = (c.slowest && BASE_MINUTES[c.slowest] !== undefined ? c.slowest : null)
    ?? planUnits.filter((u) => BASE_MINUTES[u] !== undefined).sort((x, y) => BASE_MINUTES[y] - BASE_MINUTES[x])[0]
    ?? null;
  const never = ['snob', 'knight'];
  const allowed = slowest
    ? Object.keys(BASE_MINUTES).filter((u) => !never.includes(u) && BASE_MINUTES[u] <= BASE_MINUTES[slowest])
    : planUnits.filter((u) => !never.includes(u));
  return { allowed, required: slowest };
}

const shortageText = (short) => short.map((s) => `${UNIT_NAMES[s.unit] ?? s.unit}: kell ${s.want}, van ${s.have}`).join('; ');

/** Induláskori ellenőrzés: minden kiinduló falu otthoni egységei a még hátralévő parancsokhoz. */
async function preflightUnits({ sender, commands, sourceIdOf, log }) {
  const now = Date.now();
  const byVillage = new Map();
  for (const c of commands) {
    if (c.launch <= now) continue;
    const id = sourceIdOf(c);
    if (!id) continue;
    if (!byVillage.has(id)) byVillage.set(id, []);
    byVillage.get(id).push(c);
  }
  if (!byVillage.size) return;
  log.title('Egységek ellenőrzése (ami most otthon van)');
  let problems = 0;
  for (const [id, list] of byVillage) {
    const name = list[0].source.name ?? list[0].source.coord;
    let have;
    try {
      have = await sender.availableUnits(id);
    } catch (err) {
      if (err instanceof SenderError && /Botvédelem|munkamenet/.test(err.message)) throw err;
      log.warn(`  ! ${name}: nem sikerült lekérni (${err.message})`);
      problems++;
      continue;
    }
    if (!have) { log.warn(`  ! ${name}: az otthoni egységek nem olvashatók ki az oldalról`); problems++; continue; }
    log.detail(`  ${name}: ${unitsText(Object.fromEntries(Object.entries(have).filter(([, n]) => n > 0))) || 'nincs otthon egység'}`);
    for (const c of list) {
      const sa = sendAllOptions(c);
      if (sa) {
        const { send, leftHome } = allUnits(have, sa);
        if (sa.required && !send[sa.required]) {
          log.warn(`  ! #${c.order} ${c.roleName}: a leglassabb egység (${UNIT_NAMES[sa.required] ?? sa.required}) nincs otthon – így nem megy ki`);
          problems++;
        } else {
          const less = unitShortage(c.parts[0].units, send);
          log.ok(`  ✓ #${c.order} ${c.roleName}: minden otthoni egység megy – ${unitsText(send)}`);
          if (less.length) log.detail(`      a tervhez képest kevesebb: ${shortageText(less)}`);
          if (Object.keys(leftHome).length) log.detail(`      otthon marad (nemes/lovag, vagy lassabb a tervezettnél): ${unitsText(leftHome)}`);
        }
      } else {
        const total = {};
        for (const p of c.parts) for (const [u, n] of Object.entries(p.units)) total[u] = (total[u] ?? 0) + Number(n);
        const short = unitShortage(total, have);
        if (short.length) { log.warn(`  ! #${c.order} ${c.roleName}: HIÁNYZIK – ${shortageText(short)}`); problems++; }
        else log.ok(`  ✓ #${c.order} ${c.roleName}: megvan minden egység (${unitsText(total)})`);
      }
    }
    if (list.length > 1) log.detail(`      ebből a faluból ${list.length} parancs indul – az ellenőrzés parancsonként nézi, a parancsok együtt fogyasztják az egységeket`);
    await new Promise((r) => setTimeout(r, 400));
  }
  if (problems) log.warn(`  ${problems} probléma – ha a hiányzó egységek az indításig hazaérnek, rendben lesz; különben javítsd a tervet.`);
}

export async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (err) { console.error(err.message); return 2; }

  const logDir = resolve('logs');
  const baseLog = createLogger(logDir);
  const status = createStatusLine();
  const log = Object.fromEntries(Object.entries(baseLog).map(([k, fn]) => [k, (m) => { status.clear(); fn(m); }]));

  // --- Parancsépítő mód (a --plan itt csak az egységsebességekhez kellhet) ---
  if (opts.build) {
    try { return await runBuild(opts, log); } catch (err) { log.error(err.message); return 1; }
  }

  const planPath = resolve(opts.plan);
  let plan;
  try { plan = loadPlan(planPath); } catch (err) { log.error(err.message); return 1; }
  const { meta, commands } = plan;

  // --- Kalibráció: egy már kiment parancs játékban látott érkezése → óraeltérés ---
  if (opts.calibrate !== undefined) {
    try { return runCalibrate(opts, plan, planPath, log); } catch (err) { log.error(err.message); return 1; }
  }

  log.title(`▣ ${meta.plan ?? basename(planPath)}`);

  let world = null;
  if (meta.server && !opts.offline) {
    try {
      world = await loadWorld(meta.server, { log, refresh: opts.refresh });
      log.detail(`  Világ: ${world.world} · sebesség ${world.speed}× · egységsebesség ${world.unitSpeed}× · ${world.villages.size} falu, ${world.players.size} játékos (nyilvános adatok)`);
    } catch (err) {
      log.warn(`  ! A világadatok nem érhetők el (${err.message}) – a terv feltevéseivel számolok.`);
    }
  }

  if (opts.villages !== null) return printVillages(log, world, opts.villages || meta.player);

  const issues = checkPlan(plan, { now: opts.shift === null ? Date.now() : -Infinity, world });
  printSchedule(log, commands);
  log.title(`Ellenőrzés${world ? ' (a világ hivatalos adataival)' : ''}`);
  printIssues(log, issues);

  if (opts.html !== null) {
    const out = resolve(opts.html || planPath.replace(/.json$/i, '') + '.html');
    writeFileSync(out, renderDashboard(buildDashboardData(plan, issues, world)), 'utf8');
    log.ok(`✓ Indítópult elkészült: ${out}`);
    log.detail('  Nyisd meg a böngészőben (dupla kattintás). Az oldal semmit nem küld.');
    return 0;
  }
  if (opts.check) return 0;

  // --- Éles küldő (csak valós időben, --send session.json) ---
  const sourceIdOf = (c) => c.source.id ?? world?.villageAt(c.source.coord)?.id ?? null;
  let sender = null;
  if (opts.send) {
    if (!meta.server) { log.error('Éles küldéshez a tervben a "server" mező kell (pl. https://hu103.klanhaboru.hu/game.php).'); return 1; }
    try {
      const session = loadSession(resolve(opts.send));
      sender = createSender({ server: meta.server, session, log, attackLabel: opts.attackLabel });
      const firstId = commands[0].source.id ?? world?.villageAt(commands[0].source.coord)?.id;
      await sender.checkSession(firstId);
      await preflightUnits({ sender, commands, sourceIdOf, log });
      log.title('⚠ ÉLES KÜLDÉS – a támadások valóban kimennek a játéknak');
    } catch (err) {
      log.error(`A küldés nem indul: ${err.message}`);
      return 1;
    }
  }

  // --- Idővonal: virtuális (terv szerinti) idő ↔ valós idő ---
  const clock = createClock();
  const r0 = clock.now();
  const speed = opts.speed;
  const firstLaunch = commands[0].launch;
  const v0 = opts.shift !== null ? firstLaunch - opts.shift * speed : r0;
  const toReal = (v) => r0 + (v - v0) / speed;
  const toVirtual = (r) => v0 + (r - r0) * speed;

  // --- Események: előfigyelmeztetések + (élesnél) előkészítés + minden vonatrész külön indítás ---
  const events = [];
  for (const c of commands) {
    for (const w of opts.warnings) events.push({ kind: 'warn', at: c.launch - w, cmd: c, before: w });
    if (sender) events.push({ kind: 'prepare', at: c.launch - opts.prepareMs, cmd: c });
    for (const p of c.parts) events.push({ kind: 'launch', at: c.launch, cmd: c, part: p });
  }
  events.sort((a, b) => a.at - b.at || (a.kind === 'warn' ? -1 : a.kind === 'prepare' ? -1 : 1) || a.cmd.order - b.cmd.order || (a.part?.index ?? 0) - (b.part?.index ?? 0));

  const mode = sender
    ? 'ÉLES KÜLDÉS – valós időben, a terv időpontjaiban'
    : opts.shift !== null || speed !== 1
      ? `szimuláció – ${opts.shift !== null ? `eltolva (első indítás ${formatClock(opts.shift / 1000)} múlva)` : 'valós időpontok'}${speed !== 1 ? `, ${speed}× gyorsítva` : ''}`
      : 'valós idő – a terv időpontjaiban';
  log.title(`▶ Indul: ${mode}. Leállítás: Ctrl+C`);
  if (!sender) log.detail('  A szimulátor semmit nem küld ki: az indítás pillanatában csak naplóz.');

  const results = [];
  const preparedMap = new Map(); // order → [prepared a részekhez] (éles módban)
  const failedOrders = new Set();
  let stopped = false;
  const finish = () => writeReport({ planPath, logDir, meta, mode, speed, results, log, stopped });
  process.once('SIGINT', () => { stopped = true; finish(); process.exit(130); });

  const nowV = toVirtual(clock.now());
  for (const e of events) {
    if (e.at < nowV) {
      if (e.kind === 'launch') {
        results.push({ order: e.cmd.order, part: e.part.index, status: sender ? 'hiba' : 'kimaradt', planned: new Date(e.at).toISOString(), ...(sender ? { error: 'az indítás ideje már elmúlt' } : {}) });
        if (e.part.index === 1) log.detail(`  ○ #${e.cmd.order} ${formatTimeMs(new Date(e.at))} – elmúlt, kimarad`);
      }
      continue;
    }
    const realTarget = toReal(e.at);
    const label = `#${e.cmd.order} ${e.cmd.source.name ?? e.cmd.source.coord} → ${e.cmd.target.coord}`;
    const actualReal = await waitUntil(realTarget, {
      clock,
      onTick: (remainingMs) => status.set(`⏳ következő: ${label} (${e.kind === 'warn' ? 'figyelmeztetés' : e.kind === 'prepare' ? 'előkészítés' : e.cmd.roleName}) – ${formatClock((remainingMs * speed) / 1000)} múlva`),
    });
    const deviation = actualReal - realTarget;
    const c = e.cmd;

    if (e.kind === 'warn') {
      const text = `${formatClock(e.before / 1000)} múlva indul: ${label} (${c.roleName})`;
      log.warn(`  ⏰ ${text}`);
      if (opts.notify) notify('Indítás hamarosan', text);
      continue;
    }

    if (e.kind === 'prepare') {
      // Éles mód: a megerősítő űrlapok letöltése az indítás előtt, hogy a commit ms-ra pontos legyen.
      const sourceId = sourceIdOf(c);
      try {
        const prepared = await Promise.all(c.parts.map((p) =>
          sender.prepare({ sourceId, x: c.target.pos.x, y: c.target.pos.y, units: p.units, catapultTarget: c.catapultTarget, sendAll: sendAllOptions(c) })));
        preparedMap.set(c.order, prepared);
        log.detail(`  ⚙ #${c.order} előkészítve (${c.parts.length} rész, h=${sender.h})`);
        if (c.sendAll) {
          log.detail(`      megy: ${unitsText(prepared[0].units)}`);
          if (Object.keys(prepared[0].leftHome ?? {}).length) log.detail(`      otthon marad: ${unitsText(prepared[0].leftHome)}`);
        }
      } catch (err) {
        failedOrders.add(c.order);
        log.error(`  ✗ #${c.order} előkészítés sikertelen: ${err.message}`);
        for (const p of c.parts) results.push({ order: c.order, part: p.index, status: 'hiba', planned: new Date(e.at).toISOString(), error: err.message });
      }
      continue;
    }

    const p = e.part;
    const partText = c.parts.length > 1 ? ` · ${p.index}/${c.parts.length}${p.label ? ` (${p.label})` : ''}` : '';
    // A kijelzett "tényleges" idő a cél + a valós (nem gyorsított) eltérés: a gyorsítás ne nagyítsa fel a hibát.
    const virtualActual = new Date(e.at + deviation);

    if (sender) {
      // --- Éles küldés ---
      if (failedOrders.has(c.order)) {
        log.error(`  ✗ ${label} ${c.roleName}${partText} – nem ment ki (az előkészítés nem sikerült)`);
        continue;
      }
      let preparedList = preparedMap.get(c.order);
      if (!preparedList) {
        log.warn(`  ! ${label} – nincs előkészítve, helyben készül (késve mehet ki)`);
        try {
          const sourceId = sourceIdOf(c);
          preparedList = await Promise.all(c.parts.map((pp) =>
            sender.prepare({ sourceId, x: c.target.pos.x, y: c.target.pos.y, units: pp.units, catapultTarget: c.catapultTarget, sendAll: sendAllOptions(c) })));
        } catch (err) {
          log.error(`  ✗ ${label} ${c.roleName}${partText} – hiba: ${err.message}`);
          results.push({ order: c.order, part: p.index, status: 'hiba', planned: new Date(e.at).toISOString(), error: err.message });
          continue;
        }
      }
      // A commitot minden résznél a pontos célidőre várjuk (az első után ez azonnal tér vissza).
      await waitUntil(realTarget, { clock });
      try {
        const prep = preparedList[p.index - 1];
        const sent = await sender.commit(prep);
        log.ok(`  🚀 ${label} ${c.roleName}${partText} – ELKÜLDVE`);
        log.detail(`      cél ${formatTimeMs(new Date(e.at))} · tényleges ${formatTimeMs(virtualActual)} · eltérés ${deviation >= 0 ? '+' : ''}${deviation.toFixed(2)} ms · ${unitsText(prep.units ?? p.units)}`);
        if (opts.notify && p.index === 1) notify(`Elküldve: #${c.order}`, `${c.source.name ?? c.source.coord} → ${c.target.coord} · ${c.roleName}`);
        results.push({
          order: c.order, part: p.index, status: 'elküldve', role: c.role,
          source: c.source.name ?? c.source.coord, target: c.target.coord, units: prep.units ?? p.units,
          planned: new Date(e.at).toISOString(), actual: virtualActual.toISOString(), deviationMs: Number(deviation.toFixed(3)),
          response: sent.json ?? sent.raw,
        });
      } catch (err) {
        log.error(`  ✗ ${label} ${c.roleName}${partText} – küldés sikertelen: ${err.message}`);
        if (opts.notify && p.index === 1) notify(`KÜLDÉSI HIBA: #${c.order}`, err.message);
        results.push({ order: c.order, part: p.index, status: 'hiba', role: c.role, planned: new Date(e.at).toISOString(), error: err.message });
      }
      continue;
    }

    // --- Szimuláció ---
    log.ok(`  🚀 ${label} ${c.roleName}${partText} – ITT MENT VOLNA KI`);
    log.detail(`      cél ${formatTimeMs(new Date(e.at))} · tényleges ${formatTimeMs(virtualActual)} · eltérés ${deviation >= 0 ? '+' : ''}${deviation.toFixed(2)} ms · ${partUnitsText(c, p)}`);
    if (opts.notify && p.index === 1) notify(`Indítás most: #${c.order}`, `${c.source.name ?? c.source.coord} → ${c.target.coord} · ${c.roleName}`);
    results.push({
      order: c.order, part: p.index, status: 'lefutott', role: c.role,
      source: c.source.name ?? c.source.coord, target: c.target.coord, units: p.units,
      planned: new Date(e.at).toISOString(), actual: virtualActual.toISOString(), deviationMs: Number(deviation.toFixed(3)),
    });
  }

  finish();
  return 0;
}

function writeReport({ planPath, logDir, meta, mode, speed, results, log, stopped }) {
  const done = results.filter((r) => r.status === 'lefutott' || r.status === 'elküldve');
  const failed = results.filter((r) => r.status === 'hiba');
  const devs = done.map((r) => r.deviationMs).filter((d) => d !== undefined);
  const stats = devs.length
    ? {
        count: devs.length,
        avgMs: Number((devs.reduce((a, b) => a + b, 0) / devs.length).toFixed(3)),
        maxMs: Number(Math.max(...devs).toFixed(3)),
        minMs: Number(Math.min(...devs).toFixed(3)),
        within1ms: devs.filter((d) => Math.abs(d) <= 1).length,
      }
    : null;
  const skipped = results.length - done.length - failed.length;
  log.title(`■ ${stopped ? 'Megszakítva' : 'Vége'}: ${done.length} indítás lejátszva${skipped ? `, ${skipped} kimaradt` : ''}${failed.length ? `, ${failed.length} HIBÁS` : ''}`);
  if (stats) log.info(`  Pontosság: átlag ${stats.avgMs} ms, legnagyobb ${stats.maxMs} ms, ${stats.within1ms}/${stats.count} indítás 1 ms-on belül`);

  try {
    mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = join(logDir, `terv-${stamp}.json`);
    writeFileSync(file, JSON.stringify({ plan: meta.plan, file: planPath, mode, speed, stopped, stats, results }, null, 2), 'utf8');
    log.detail(`  Riport: ${file}`);
  } catch (err) {
    log.warn(`  A riport nem írható: ${err.message}`);
  }
}
