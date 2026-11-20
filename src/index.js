#!/usr/bin/env node
// Request Scheduler – belépési pont.
//
//   node src/index.js [jobs.json]              indítás (ütemezés + fájlfigyelés)
//   node src/index.js [jobs.json] --list       jobok és a következő futások listája
//   node src/index.js [jobs.json] --check      csak a konfiguráció ellenőrzése
//   node src/index.js [jobs.json] --run <név>  egy job azonnali lefuttatása, majd kilépés

import { watchFile } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, ConfigError } from './config.js';
import { createLogger, paint, C } from './logger.js';
import { createSchedule } from './schedule.js';
import { runJob } from './runner.js';
import { Scheduler } from './scheduler.js';
import { startServer } from './server.js';
import { formatDateTime, formatRelative } from './util.js';

function parseArgs(argv) {
  const opts = { config: 'jobs.json', mode: 'serve', job: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list' || a === '-l') opts.mode = 'list';
    else if (a === '--check' || a === '-c') opts.mode = 'check';
    else if (a === '--run' || a === '-r') { opts.mode = 'run'; opts.job = argv[++i]; }
    else if (a === '--help' || a === '-h') opts.mode = 'help';
    else if (!a.startsWith('-')) opts.config = a;
    else { console.error(`Ismeretlen kapcsoló: ${a}`); process.exit(2); }
  }
  return opts;
}

const HELP = `
Request Scheduler – időzített HTTP kérések JSON alapján

  node src/index.js [jobs.json]              indítás
  node src/index.js [jobs.json] --list       jobok és következő futásaik
  node src/index.js [jobs.json] --check      konfiguráció ellenőrzése
  node src/index.js [jobs.json] --run <név>  egy job azonnali futtatása

Részletek: README.md
`;

const opts = parseArgs(process.argv.slice(2));
if (opts.mode === 'help') { console.log(HELP); process.exit(0); }

const configPath = resolve(opts.config);
const log = createLogger(join(dirname(configPath), 'logs'));

function load() {
  try {
    return loadConfig(configPath);
  } catch (err) {
    if (err instanceof ConfigError) log.error(err.message);
    else log.error(err.stack || err.message);
    return null;
  }
}

const config = load();
if (!config) process.exit(1);

if (opts.mode === 'check') {
  log.ok(`✓ A konfiguráció rendben: ${config.jobs.length} job (${configPath})`);
  process.exit(0);
}

if (opts.mode === 'list') {
  console.log(paint(C.bold, `\n${config.jobs.length} job – ${configPath}\n`));
  for (const job of config.jobs) {
    const schedule = createSchedule(job.schedule);
    const off = job.enabled === false;
    console.log(`${paint(off ? C.dim : C.bold + C.cyan, `${off ? '○' : '●'} ${job.name}`)}  ${paint(C.dim, `${schedule.describe} · ${job.requests.length} kérés${off ? ' · KIKAPCSOLVA' : ''}`)}`);
    if (job.description) console.log(`    ${job.description}`);
    let after = new Date();
    for (let i = 0; i < 3; i++) {
      const next = schedule.next(after);
      if (!next) { if (i === 0) console.log(paint(C.dim, '    nincs jövőbeli futás')); break; }
      console.log(`    ${formatDateTime(next)}  ${paint(C.dim, formatRelative(next))}`);
      after = next;
    }
    for (const r of job.requests) {
      console.log(paint(C.dim, `    → ${(r.method || (r.body !== undefined || r.form !== undefined ? 'POST' : 'GET')).toUpperCase()} ${r.url}`));
    }
    console.log('');
  }
  process.exit(0);
}

if (opts.mode === 'run') {
  const job = config.jobs.find((j) => j.name === opts.job);
  if (!job) {
    log.error(`Nincs ilyen job: "${opts.job}". Elérhetők: ${config.jobs.map((j) => j.name).join(', ')}`);
    process.exit(1);
  }
  const result = await runJob(job, config, log, 'kézi');
  process.exit(result.ok ? 0 : 1);
}

// --- Szolgáltatás mód ---
log.title(`Request Scheduler indul – ${configPath}`);
const scheduler = new Scheduler(log);
scheduler.load(config, { initial: true });

let server = null;
if (config.server?.port) server = startServer(scheduler, config.server, log);

let reloadTimer = null;
watchFile(configPath, { interval: 1000 }, (curr, prev) => {
  if (curr.mtimeMs === prev.mtimeMs) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    log.title('↻ A konfiguráció megváltozott, újratöltés…');
    const fresh = load();
    if (!fresh) { log.warn('  Az előző (működő) beállítások maradnak érvényben.'); return; }
    scheduler.load(fresh);
    if ((fresh.server?.port ?? null) !== (config.server?.port ?? null)) {
      log.warn('  A server.port változása csak újraindítás után lép életbe.');
    }
  }, 300);
});

log.detail('Fut. Leállítás: Ctrl+C. A jobs.json mentésekor automatikusan újratölt.');

function shutdown() {
  log.title('Leállás…');
  scheduler.stop();
  server?.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
