// Óraeltérés (kalibráció) a terv ideje és a játékban mutatott érkezési idő között.
//
//   játékbeli érkezés = tervezett érkezés + eltérés        (pl. −217 ms: a játék .728-at mutat a terv .945-jére)
//   tervezett érkezés = kívánt játékbeli érkezés − eltérés
//
// Az eltérés a gép órájából és a hálózati késésből áll össze; mérni csak úgy lehet, hogy egy már kiment
// parancs játékban látható érkezését összeveted a tervben szereplővel (--calibrate). A mérések a
// tervek/kalibracio.json-ba kerülnek; az érvényes érték az utolsó 5 mérés mediánja.
// Ez a modul semmilyen külső rendszerrel nem kommunikál.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const CALIBRATION_FILE = resolve('tervek', 'kalibracio.json');
const KEEP = 5;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** A mentett mérések: { samples: [{ offsetMs, at, plan, order, planned, game }] } */
export function loadCalibration(file = CALIBRATION_FILE) {
  if (!existsSync(file)) return { samples: [] };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return { samples: Array.isArray(data.samples) ? data.samples.filter((s) => Number.isFinite(s.offsetMs)) : [] };
  } catch (err) {
    throw new Error(`A kalibrációs fájl nem olvasható (${file}): ${err.message}`);
  }
}

/**
 * Az érvényes eltérés: a terv "assumptions.clock_offset_ms" értéke (ha meg van adva, az az erősebb),
 * különben a mentett mérések (utolsó 5) mediánja. null, ha nincs semmi.
 * Visszaad: { ms, source, samples, spread } – spread: a figyelembe vett mérések szórási tartománya (max−min).
 */
export function clockOffset(meta, file = CALIBRATION_FILE) {
  const fixed = meta?.assumptions?.clock_offset_ms;
  if (fixed !== undefined && fixed !== null) {
    if (!Number.isFinite(fixed)) throw new Error('assumptions.clock_offset_ms: szám kell (ms)');
    return { ms: fixed, source: 'a terv assumptions.clock_offset_ms értéke', samples: null, spread: null };
  }
  const { samples } = loadCalibration(file);
  if (!samples.length) return null;
  const last = samples.slice(-KEEP).map((s) => s.offsetMs);
  return {
    ms: median(last),
    source: `kalibracio.json – ${last.length} mérés mediánja`,
    samples: last.length,
    spread: Math.max(...last) - Math.min(...last),
  };
}

/** Új mérés mentése; visszaadja a frissített érvényes eltérést. */
export function addCalibrationSample(sample, file = CALIBRATION_FILE) {
  const data = loadCalibration(file);
  data.samples.push(sample);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    _leiras: 'Óraeltérés-mérések: játékbeli érkezés − tervezett érkezés (ms). Az érvényes érték az utolsó 5 mediánja.',
    samples: data.samples,
  }, null, 2) + '\n', 'utf8');
  return clockOffset(null, file);
}

/**
 * Játékban látott időpont értelmezése. Elfogadja:
 *   "ma 14:13:40:652", "holnap 07:00:01:100", "14:13:40:652" (= ma), "14:13:40.652",
 *   "2026-11-22 14:13:40.652", "2026-11-22T14:13:40.652+01:00"
 * A ms elválasztója lehet ":" (ahogy a játék mutatja) vagy ".". Hiányzó ms = 000.
 */
export function parseGameTime(text, { now = Date.now() } = {}) {
  const raw = String(text ?? '').trim();
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(raw);
  if (iso) {
    const [, date, h, m, s, ms = '0', zone] = iso;
    const t = Date.parse(`${date}T${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}${zone ?? ''}`);
    if (!Number.isNaN(t)) return t;
  }
  const rel = /^(?:(ma|holnap|holnapután)\s+)?(\d{1,2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/i.exec(raw);
  if (rel) {
    const [, day = 'ma', h, m, s, ms = '0'] = rel;
    const d = new Date(now);
    d.setDate(d.getDate() + { ma: 0, holnap: 1, holnapután: 2 }[day.toLowerCase()]);
    d.setHours(Number(h), Number(m), Number(s), Number(ms.padEnd(3, '0')));
    return d.getTime();
  }
  throw new Error(`Nem értem az időpontot: "${text}" (pl. "ma 14:13:40:652", "holnap 07:00:01:100", "2026-11-22 14:13:40.652")`);
}
