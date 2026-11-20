// Apró segédfüggvények: időtartamok, dátumformázás, útvonal-kiolvasás.

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "1h30m", "45s", "500ms", "2d" vagy szám (ms) → milliszekundum */
export function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') throw new Error(`Érvénytelen időtartam: ${JSON.stringify(value)}`);
  const text = value.trim().toLowerCase().replace(/\s+/g, '');
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = '';
  for (const match of text.matchAll(re)) {
    total += Number(match[1]) * UNITS[match[2]];
    consumed += match[0];
  }
  if (!consumed || consumed !== text) {
    throw new Error(`Érvénytelen időtartam: "${value}" (példák: "30s", "15m", "1h30m", "1d")`);
  }
  return total;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** HH:mm:ss.SSS */
export function formatTimeMs(d) {
  return `${formatTime(d)}.${pad(d.getMilliseconds(), 3)}`;
}

/** 3725 mp → "1:02:05" */
export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  return `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function formatDateTime(d) {
  return d ? `${formatDate(d)} ${formatTime(d)}` : '—';
}

/** "4 perc 12 mp múlva" jellegű relatív szöveg */
export function formatRelative(target, now = new Date()) {
  let ms = target.getTime() - now.getTime();
  if (ms < 1000) return 'most';
  const parts = [];
  const d = Math.floor(ms / 86_400_000); ms -= d * 86_400_000;
  const h = Math.floor(ms / 3_600_000); ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000); ms -= m * 60_000;
  const s = Math.floor(ms / 1000);
  if (d) parts.push(`${d} nap`);
  if (h) parts.push(`${h} óra`);
  if (m && !d) parts.push(`${m} perc`);
  if (!d && !h && s) parts.push(`${s} mp`);
  return `${parts.join(' ')} múlva`;
}

/** Helyi idő szerinti dátum: "2026-11-21T08:00", "2026-11-21 08:00:00" vagy teljes ISO (Z/+01:00). */
export function parseLocalDateTime(value) {
  if (typeof value !== 'string') throw new Error(`Érvénytelen időpont: ${JSON.stringify(value)}`);
  const normalized = value.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(normalized)) {
    throw new Error(`Érvénytelen időpont: "${value}" (formátum: "2026-11-21 08:00" vagy "2026-11-21T08:00:00")`);
  }
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) throw new Error(`Érvénytelen időpont: "${value}"`);
  return d;
}

/** "body.items[0].id" → érték az objektumból (vagy undefined) */
export function getPath(obj, path) {
  const keys = String(path).replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const key of keys) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function truncate(text, max) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}… (+${oneLine.length - max} karakter)` : oneLine;
}
