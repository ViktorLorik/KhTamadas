// {{változó}} behelyettesítés stringekbe, objektumokba, tömbökbe.
// Elérhető: config/job "variables", korábbi lépésekből "save"-elt értékek,
// {{responses.<lépésnév>.body.x}}, {{last.status}}, {{env.NEV}}, és beépítettek:
// {{now}} {{timestamp}} {{unix}} {{date}} {{time}} {{uuid}}

import { randomUUID } from 'node:crypto';
import { formatDate, formatTime, getPath } from './util.js';

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

function builtin(name) {
  const now = new Date();
  switch (name) {
    case 'now': return now.toISOString();
    case 'timestamp': return now.getTime();
    case 'unix': return Math.floor(now.getTime() / 1000);
    case 'date': return formatDate(now);
    case 'time': return formatTime(now);
    case 'uuid': return randomUUID();
    default: return undefined;
  }
}

function resolve(expr, scope) {
  const fromScope = getPath(scope, expr);
  return fromScope !== undefined ? fromScope : builtin(expr);
}

/** Behelyettesít; a fel nem oldható helyőrzők neveit a `missing` halmazba gyűjti. */
export function render(value, scope, missing = new Set()) {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) {
      // Ha az egész string egyetlen helyőrző, az eredeti típus marad (szám, objektum…)
      const v = resolve(whole[1], scope);
      if (v === undefined) { missing.add(whole[1]); return value; }
      return v;
    }
    return value.replace(PLACEHOLDER, (m, expr) => {
      const v = resolve(expr, scope);
      if (v === undefined) { missing.add(expr); return m; }
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => render(v, scope, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [render(k, scope, missing), render(v, scope, missing)]));
  }
  return value;
}
