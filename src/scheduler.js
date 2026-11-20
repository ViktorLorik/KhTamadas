// Időzítő: minden jobhoz kiszámolja a következő futást és setTimeout-tal elindítja.

import { createSchedule } from './schedule.js';
import { runJob } from './runner.js';
import { formatDateTime, formatRelative } from './util.js';

const MAX_TIMEOUT = 2_147_483_647; // setTimeout felső korlátja (~24,8 nap)
const LATE_TOLERANCE = 60_000;     // ennél nagyobb késésnél (pl. alvó gép) nem pótol sorozatot

export class Scheduler {
  constructor(log) {
    this.log = log;
    this.states = new Map();
    this.config = { jobs: [] };
    this.running = new Set(); // futó jobok neve (újratöltést is túléli)
  }

  /** (Újra)tölti a jobokat; a futási előzmények név szerint megmaradnak. */
  load(config, { initial = false } = {}) {
    const previous = this.states;
    for (const s of previous.values()) clearTimeout(s.timer);
    this.config = config;
    this.states = new Map();
    const now = new Date();

    for (const job of config.jobs) {
      const old = previous.get(job.name);
      const state = {
        job,
        schedule: createSchedule(job.schedule),
        enabled: job.enabled !== false,
        timer: null,
        nextRun: null,
        lastRun: old?.lastRun ?? null,
        lastResult: old?.lastResult ?? null,
        runs: old?.runs ?? 0,
      };
      this.states.set(job.name, state);
      if (!state.enabled) {
        this.log.detail(`  ○ ${job.name} – kikapcsolva ("enabled": false)`);
        continue;
      }
      this.plan(state, now);
      if (initial && job.runOnStart) this.trigger(state, 'indításkor');
    }
  }

  plan(state, after) {
    state.nextRun = state.schedule.next(after);
    if (!state.nextRun) {
      this.log.detail(`  ○ ${state.job.name} – ${state.schedule.describe}: nincs több jövőbeli futás`);
      return;
    }
    this.log.info(`  ⏱ ${state.job.name} – ${state.schedule.describe} → következő: ${formatDateTime(state.nextRun)} (${formatRelative(state.nextRun)})`);
    this.arm(state);
  }

  arm(state) {
    const delay = Math.max(0, state.nextRun.getTime() - Date.now());
    state.timer = setTimeout(() => {
      if (Date.now() < state.nextRun.getTime() - 5) return this.arm(state); // hosszú várakozás darabolva
      this.fire(state);
    }, Math.min(delay, MAX_TIMEOUT));
  }

  fire(state) {
    const planned = state.nextRun.getTime();
    const now = Date.now();
    const late = now - planned;
    if (late > LATE_TOLERANCE) this.log.warn(`  ! ${state.job.name} – ${Math.round(late / 1000)} mp késéssel indul (aludt a gép?)`);
    this.trigger(state, 'ütemezett');
    this.plan(state, new Date(late > LATE_TOLERANCE ? now : planned));
  }

  /** Azonnali futtatás (ütemezett, indításkori vagy kézi). */
  async trigger(state, reason) {
    if (this.running.has(state.job.name) && !state.job.allowOverlap) {
      this.log.warn(`  ! ${state.job.name} – még fut az előző, ez a futás kimarad`);
      return null;
    }
    this.running.add(state.job.name);
    state.runs += 1;
    state.lastRun = new Date();
    try {
      state.lastResult = await runJob(state.job, this.config, this.log, reason);
    } catch (err) {
      this.log.error(`  ✗ ${state.job.name} – váratlan hiba: ${err.stack || err.message}`);
      state.lastResult = { ok: false, error: err.message };
    } finally {
      this.running.delete(state.job.name);
    }
    return state.lastResult;
  }

  runNow(name) {
    const state = this.states.get(name);
    if (!state) return null;
    return this.trigger(state, 'kézi');
  }

  stop() {
    for (const s of this.states.values()) clearTimeout(s.timer);
  }

  status() {
    return [...this.states.values()].map((s) => ({
      name: s.job.name,
      enabled: s.enabled,
      schedule: s.schedule.describe,
      requests: s.job.requests.length,
      running: this.running.has(s.job.name),
      runs: s.runs,
      nextRun: s.nextRun ? formatDateTime(s.nextRun) : null,
      lastRun: s.lastRun ? formatDateTime(s.lastRun) : null,
      lastResult: s.lastResult,
    }));
  }
}
