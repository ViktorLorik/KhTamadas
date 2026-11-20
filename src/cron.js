// Minimális cron-értelmező (5 mező: perc óra nap hónap hét-napja), helyi idő szerint.
// Támogatja: *, számok, listák (1,15), tartományok (1-5), lépésköz (*/10, 8-18/2),
// hónap- és napnevek (jan..dec, sun..sat, pl. mon-fri), valamint @daily, @hourly stb.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const FIELDS = [
  { name: 'perc', min: 0, max: 59 },
  { name: 'óra', min: 0, max: 23 },
  { name: 'nap', min: 1, max: 31 },
  { name: 'hónap', min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: 'hét napja', min: 0, max: 7, names: DAYS, offset: 0 },
];

const ALIASES = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

function toNumber(token, field, expr) {
  const lower = token.toLowerCase();
  if (field.names) {
    const idx = field.names.indexOf(lower);
    if (idx >= 0) return idx + field.offset;
  }
  if (!/^\d+$/.test(token)) throw new Error(`Hibás cron "${expr}": "${token}" nem érvényes a(z) ${field.name} mezőben`);
  const n = Number(token);
  if (n < field.min || n > field.max) {
    throw new Error(`Hibás cron "${expr}": ${n} kívül esik a(z) ${field.name} mező tartományán (${field.min}-${field.max})`);
  }
  return n;
}

function parseField(text, field, expr) {
  const values = new Set();
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Hibás cron "${expr}": érvénytelen lépésköz "${stepText}"`);
    let lo;
    let hi;
    if (range === '*') {
      lo = field.min;
      hi = field.max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = toNumber(a, field, expr);
      hi = toNumber(b, field, expr);
      if (lo > hi) throw new Error(`Hibás cron "${expr}": fordított tartomány "${range}"`);
    } else {
      lo = toNumber(range, field, expr);
      hi = stepText === undefined ? lo : field.max;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expression) {
  const expr = String(expression).trim();
  const normalized = ALIASES[expr.toLowerCase()] ?? expr;
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Hibás cron "${expr}": 5 mező kell (perc óra nap hónap hét-napja), pl. "0 8 * * mon-fri"`);
  }
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i], expr));
  if (weekdays.has(7)) { weekdays.delete(7); weekdays.add(0); }
  const domAny = parts[2].startsWith('*');
  const dowAny = parts[4].startsWith('*');

  const dayMatches = (d) => {
    const dom = days.has(d.getDate());
    const dow = weekdays.has(d.getDay());
    if (domAny && dowAny) return true;
    if (domAny) return dow;
    if (dowAny) return dom;
    return dom || dow; // klasszikus cron: ha mindkettő meg van adva, bármelyik elég
  };

  /** Az `after` utáni első egyező perc (Date), vagy null, ha 5 éven belül nincs ilyen. */
  function next(after) {
    const d = new Date(after.getTime());
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    const limit = after.getTime() + 5 * 366 * 86_400_000;
    while (d.getTime() <= limit) {
      if (!months.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
      if (!dayMatches(d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
      if (!hours.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
      if (!minutes.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
      return d;
    }
    return null;
  }

  return { expression: expr, next };
}
