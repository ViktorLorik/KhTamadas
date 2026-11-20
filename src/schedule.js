// Ütemezés-típusok: at (fix időpont/ok), every (ismétlődő időköz), daily (napi időpontok), cron.

import { parseCron } from './cron.js';
import { parseDuration, parseLocalDateTime, formatDateTime } from './util.js';

const DAY_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  vas: 0, hét: 1, het: 1, ked: 2, sze: 3, csü: 4, csu: 4, pén: 5, pen: 5, szo: 6,
};

/**
 * Egy job "schedule" mezőjéből ütemezőt készít.
 * Visszaad: { kind, describe, next(after: Date): Date | null }
 */
export function createSchedule(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Hiányzik a "schedule" objektum');
  const kinds = ['at', 'every', 'daily', 'cron'].filter((k) => spec[k] !== undefined);
  if (kinds.length !== 1) {
    throw new Error(`A "schedule" pontosan egyet tartalmazzon ezek közül: at, every, daily, cron (most: ${kinds.join(', ') || 'egyik sem'})`);
  }
  const kind = kinds[0];

  if (kind === 'at') {
    const list = (Array.isArray(spec.at) ? spec.at : [spec.at]).map(parseLocalDateTime).sort((a, b) => a - b);
    return {
      kind,
      describe: list.length === 1 ? `egyszer: ${formatDateTime(list[0])}` : `${list.length} fix időpont`,
      next: (after) => list.find((d) => d.getTime() > after.getTime()) ?? null,
    };
  }

  if (kind === 'every') {
    const interval = parseDuration(spec.every);
    if (interval < 1000) throw new Error('Az "every" legalább 1 másodperc legyen');
    return {
      kind,
      interval,
      describe: `${spec.every} időközönként`,
      next: (after) => new Date(after.getTime() + interval),
    };
  }

  if (kind === 'daily') {
    const times = Array.isArray(spec.daily) ? spec.daily : [spec.daily];
    const parsed = times.map((t) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Érvénytelen napi időpont: "${t}" (formátum: "08:30")`);
      return { h: Number(m[1]), m: Number(m[2]) };
    });
    let dowPart = '*';
    if (spec.days) {
      const days = (Array.isArray(spec.days) ? spec.days : [spec.days]).map((d) => {
        const key = String(d).trim().toLowerCase().slice(0, 3);
        if (!(key in DAY_NAMES)) throw new Error(`Ismeretlen nap: "${d}" (pl. "mon", "tue" vagy "hét", "ked", "sze")`);
        return DAY_NAMES[key];
      });
      dowPart = [...new Set(days)].join(',');
    }
    const crons = parsed.map(({ h, m }) => parseCron(`${m} ${h} * * ${dowPart}`));
    const dayText = spec.days ? ` (${[].concat(spec.days).join(', ')})` : '';
    return {
      kind,
      describe: `naponta ${times.join(', ')}${dayText}`,
      next: (after) => crons.map((c) => c.next(after)).filter(Boolean).sort((a, b) => a - b)[0] ?? null,
    };
  }

  const cron = parseCron(spec.cron);
  return { kind, describe: `cron "${cron.expression}"`, next: (after) => cron.next(after) };
}
