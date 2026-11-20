// Tervszimulátor: a terv minden indítását ezredmásodperc-pontosan "lejátssza".
// Az indítás pillanatában naplóz ("itt ment volna ki"), opcionálisan Windows-értesítést küld,
// a végén riportot ír az időzítés pontosságáról. Semmilyen külső rendszerhez nem csatlakozik.
//
//   node src/index.js --plan tervek/terv.json              valós időben, a terv időpontjaiban
//   node src/index.js --plan tervek/terv.json --check      csak ellenőrzés + menetrend
//   node src/index.js --plan tervek/terv.json --shift 10s  eltolva: az első indítás 10 mp múlva
//   node src/index.js --plan tervek/terv.json --speed 60   60× gyorsítva (a pontosság valós ms-ban mérve)
//   ... --notify          Windows-értesítés figyelmeztetéskor és indításkor
//   ... --warn 2m,15s     előfigyelmeztetések (alapból 2m,15s; "none" = nincs)

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createLogger, paint, C } from '../logger.js';
import { formatClock, formatDate, formatTimeMs, parseDuration } from '../util.js';
import { loadPlan, checkPlan, unitsText } from './plan.js';
import { createClock, waitUntil } from './precise.js';
import { notify } from './notify.js';
import { loadWorld } from './world.js';

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
  const o = { plan: null, check: false, shift: null, speed: 1, notify: false, warn: '2m,15s', offline: false, refresh: false, villages: null };
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
    else if (a === '--villages') o.villages = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '';
    else throw new Error(`Ismeretlen kapcsoló terv módban: ${a}`);
  }
  if (!o.plan) throw new Error('Add meg a tervet: --plan <fájl>');
  if (!(o.speed > 0) || o.speed > 10_000) throw new Error('A --speed 0 és 10000 közötti szám legyen');
  o.warnings = o.warn === 'none' ? [] : o.warn.split(',').map((w) => parseDuration(w.trim())).sort((a, b) => b - a);
  return o;
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
    const parts = c.parts.length > 1 ? ` · ${c.parts.length} rész` : '';
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

export async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (err) { console.error(err.message); return 2; }

  const planPath = resolve(opts.plan);
  const logDir = resolve('logs');
  const baseLog = createLogger(logDir);
  const status = createStatusLine();
  const log = Object.fromEntries(Object.entries(baseLog).map(([k, fn]) => [k, (m) => { status.clear(); fn(m); }]));

  let plan;
  try { plan = loadPlan(planPath); } catch (err) { log.error(err.message); return 1; }
  const { meta, commands } = plan;

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
  if (opts.check) return 0;

  // --- Idővonal: virtuális (terv szerinti) idő ↔ valós idő ---
  const clock = createClock();
  const r0 = clock.now();
  const speed = opts.speed;
  const firstLaunch = commands[0].launch;
  const v0 = opts.shift !== null ? firstLaunch - opts.shift * speed : r0;
  const toReal = (v) => r0 + (v - v0) / speed;
  const toVirtual = (r) => v0 + (r - r0) * speed;

  // --- Események: előfigyelmeztetések + minden vonatrész külön indítás ---
  const events = [];
  for (const c of commands) {
    for (const w of opts.warnings) events.push({ kind: 'warn', at: c.launch - w, cmd: c, before: w });
    for (const p of c.parts) events.push({ kind: 'launch', at: c.launch, cmd: c, part: p });
  }
  events.sort((a, b) => a.at - b.at || (a.kind === 'warn' ? -1 : 1) || a.cmd.order - b.cmd.order || (a.part?.index ?? 0) - (b.part?.index ?? 0));

  const mode = opts.shift !== null || speed !== 1
    ? `szimuláció – ${opts.shift !== null ? `eltolva (első indítás ${formatClock(opts.shift / 1000)} múlva)` : 'valós időpontok'}${speed !== 1 ? `, ${speed}× gyorsítva` : ''}`
    : 'valós idő – a terv időpontjaiban';
  log.title(`▶ Indul: ${mode}. Leállítás: Ctrl+C`);
  log.detail('  A szimulátor semmit nem küld ki: az indítás pillanatában csak naplóz.');

  const results = [];
  let stopped = false;
  const finish = () => writeReport({ planPath, logDir, meta, mode, speed, results, log, stopped });
  process.once('SIGINT', () => { stopped = true; finish(); process.exit(130); });

  const nowV = toVirtual(clock.now());
  for (const e of events) {
    if (e.at < nowV) {
      if (e.kind === 'launch') {
        results.push({ order: e.cmd.order, part: e.part.index, status: 'kimaradt', planned: new Date(e.at).toISOString() });
        if (e.part.index === 1) log.detail(`  ○ #${e.cmd.order} ${formatTimeMs(new Date(e.at))} – elmúlt, kimarad`);
      }
      continue;
    }
    const realTarget = toReal(e.at);
    const label = `#${e.cmd.order} ${e.cmd.source.name ?? e.cmd.source.coord} → ${e.cmd.target.coord}`;
    const actualReal = await waitUntil(realTarget, {
      clock,
      onTick: (remainingMs) => status.set(`⏳ következő: ${label} (${e.kind === 'warn' ? 'figyelmeztetés' : e.cmd.roleName}) – ${formatClock((remainingMs * speed) / 1000)} múlva`),
    });
    const deviation = actualReal - realTarget;
    const c = e.cmd;

    if (e.kind === 'warn') {
      const text = `${formatClock(e.before / 1000)} múlva indul: ${label} (${c.roleName})`;
      log.warn(`  ⏰ ${text}`);
      if (opts.notify) notify('Indítás hamarosan', text);
      continue;
    }

    const p = e.part;
    const partText = c.parts.length > 1 ? ` · ${p.index}/${c.parts.length}${p.label ? ` (${p.label})` : ''}` : '';
    // A kijelzett "tényleges" idő a cél + a valós (nem gyorsított) eltérés: a gyorsítás ne nagyítsa fel a hibát.
    const virtualActual = new Date(e.at + deviation);
    log.ok(`  🚀 ${label} ${c.roleName}${partText} – ITT MENT VOLNA KI`);
    log.detail(`      cél ${formatTimeMs(new Date(e.at))} · tényleges ${formatTimeMs(virtualActual)} · eltérés ${deviation >= 0 ? '+' : ''}${deviation.toFixed(2)} ms · ${unitsText(p.units)}`);
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
  const done = results.filter((r) => r.status === 'lefutott');
  const devs = done.map((r) => r.deviationMs);
  const stats = devs.length
    ? {
        count: devs.length,
        avgMs: Number((devs.reduce((a, b) => a + b, 0) / devs.length).toFixed(3)),
        maxMs: Number(Math.max(...devs).toFixed(3)),
        minMs: Number(Math.min(...devs).toFixed(3)),
        within1ms: devs.filter((d) => Math.abs(d) <= 1).length,
      }
    : null;
  const skipped = results.length - done.length;
  log.title(`■ ${stopped ? 'Megszakítva' : 'Vége'}: ${done.length} indítás lejátszva${skipped ? `, ${skipped} kimaradt` : ''}`);
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
