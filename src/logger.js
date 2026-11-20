// Színes konzolnapló + napi naplófájl (logs/ÉÉÉÉ-HH-NN.log).

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatDate, formatDateTime } from './util.js';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (color, text) => (useColor ? `${color}${text}${C.reset}` : text);

export function createLogger(dir) {
  let fileOk = true;
  try { mkdirSync(dir, { recursive: true }); } catch { fileOk = false; }

  function write(level, color, message) {
    const now = new Date();
    const ts = formatDateTime(now);
    const line = `${paint(C.dim, ts)} ${paint(color, message)}`;
    if (level === 'ERROR') console.error(line); else console.log(line);
    if (fileOk) {
      try {
        appendFileSync(join(dir, `${formatDate(now)}.log`), `${ts} [${level}] ${message}\n`, 'utf8');
      } catch {
        fileOk = false;
      }
    }
  }

  return {
    info: (m) => write('INFO', C.cyan, m),
    ok: (m) => write('OK', C.green, m),
    warn: (m) => write('WARN', C.yellow, m),
    error: (m) => write('ERROR', C.red, m),
    detail: (m) => write('INFO', C.dim, m),
    title: (m) => write('INFO', C.bold + C.magenta, m),
  };
}

export { paint, C };
