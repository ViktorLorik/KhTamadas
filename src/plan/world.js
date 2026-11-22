// A világ NYILVÁNOS adatai: falvak, játékosok, klánok, világbeállítás, egységsebességek.
// Ezeket a játék maga teszi közzé külső eszközök számára (bejelentkezés nélkül).
// Szabály: óránként legfeljebb egyszer töltsük le → helyi gyorsítótár a cache/<világ>/ mappában.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_AGE_MS = 60 * 60 * 1000;
const FILES = {
  'village.txt': 'map/village.txt',
  'player.txt': 'map/player.txt',
  'ally.txt': 'map/ally.txt',
  'config.xml': 'interface.php?func=get_config',
  'unit_info.xml': 'interface.php?func=get_unit_info',
};

const decodeName = (s) => {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
};

async function cached(server, dir, name, log, { refresh }) {
  const file = join(dir, name);
  const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < MAX_AGE_MS;
  if (fresh && !refresh) return readFileSync(file, 'utf8');
  try {
    const res = await fetch(`${server}/${FILES[name]}`, {
      headers: { 'User-Agent': 'request-scheduler/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    writeFileSync(file, text, 'utf8');
    log?.detail(`  ↓ ${name} letöltve (${Math.round(text.length / 1024)} KB)`);
    return text;
  } catch (err) {
    if (existsSync(file)) {
      log?.warn(`  ! ${name}: a letöltés nem sikerült (${err.message}), a régebbi helyi példányt használom`);
      return readFileSync(file, 'utf8');
    }
    throw new Error(`${name} nem tölthető le: ${err.message}`);
  }
}

/** Egyszerű XML-olvasó a get_config / get_unit_info válaszokhoz: <a><b>1</b></a> → { a: { b: 1 } } */
function parseXml(xml) {
  const body = xml.replace(/<\?xml[^>]*\?>/, '').trim();
  const walk = (s) => {
    const out = {};
    const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let m;
    let any = false;
    while ((m = re.exec(s))) {
      any = true;
      const inner = m[2].trim();
      out[m[1]] = /<\w+>/.test(inner) ? walk(inner) : (inner !== '' && !Number.isNaN(Number(inner)) ? Number(inner) : inner);
    }
    return any ? out : s;
  };
  const root = walk(body);
  return root.config ?? root;
}

/**
 * Betölti a világ adatait. A szerver a terv "server" mezőjéből jön, pl. https://hu103.klanhaboru.hu/game.php
 * @returns {Promise<World>}
 */
export async function loadWorld(server, { log, refresh = false, cacheRoot = resolve('cache') } = {}) {
  const url = new URL(server);
  const world = url.hostname.split('.')[0];
  const dir = join(cacheRoot, world);
  mkdirSync(dir, { recursive: true });
  const opts = { refresh };

  const [villageTxt, playerTxt, allyTxt, configXml, unitXml] = await Promise.all(
    Object.keys(FILES).map((name) => cached(url.origin, dir, name, log, opts)),
  );

  const allies = new Map();
  for (const line of allyTxt.split('\n').filter(Boolean)) {
    const [id, name, tag, members, villages, points] = line.split(',');
    allies.set(Number(id), { id: Number(id), name: decodeName(name), tag: decodeName(tag), members: Number(members), villages: Number(villages), points: Number(points) });
  }
  const players = new Map();
  const playersByName = new Map();
  for (const line of playerTxt.split('\n').filter(Boolean)) {
    const [id, name, allyId, villages, points, rank] = line.split(',');
    const p = { id: Number(id), name: decodeName(name), ally: allies.get(Number(allyId)) ?? null, villages: Number(villages), points: Number(points), rank: Number(rank) };
    players.set(p.id, p);
    playersByName.set(p.name.toLowerCase(), p);
  }
  const villages = new Map();
  const byCoord = new Map();
  for (const line of villageTxt.split('\n').filter(Boolean)) {
    const [id, name, x, y, playerId, points] = line.split(',');
    const v = { id: Number(id), name: decodeName(name), x: Number(x), y: Number(y), coord: `${x}|${y}`, owner: players.get(Number(playerId)) ?? null, points: Number(points) };
    villages.set(v.id, v);
    byCoord.set(v.coord, v);
  }

  const config = parseXml(configXml);
  const units = parseXml(unitXml);
  const secondsPerField = Object.fromEntries(
    Object.entries(units).filter(([, u]) => typeof u === 'object' && u.speed).map(([k, u]) => [k, u.speed * 60]),
  );
  const night = config.night?.active ? { start: config.night.start_hour, end: config.night.end_hour } : null;

  return {
    world,
    server: url.origin,
    speed: config.speed,
    unitSpeed: config.unit_speed,
    night,
    secondsPerField,
    villages,
    players,
    villageAt: (coord) => byCoord.get(coord) ?? null,
    player: (name) => playersByName.get(String(name).toLowerCase()) ?? null,
    villagesOf: (player) => [...villages.values()].filter((v) => v.owner?.id === player.id),
  };
}
