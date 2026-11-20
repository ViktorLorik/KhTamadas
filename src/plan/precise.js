// Ezredmásodperc-pontos várakozás Node.js-ben.
//
// A setTimeout önmagában pontatlan: Windowson az időzítő felbontása akár ~15 ms,
// és terhelés alatt még több is lehet a késés. Ezért két fázisban várunk:
//   1. durva fázis – setTimeout legfeljebb 1 mp-es darabokban, a cél előtt COARSE_MARGIN ms-mal áll meg
//      (közben frissülhet a visszaszámláló, és újrakalibráljuk az órát);
//   2. finom fázis – setImmediate-tel "pörgünk" a célpillanatig. Ez pár tíz ms CPU,
//      de az eseményhurok közben sem fagy le.
// Az idő forrása a monoton performance.now(), amit a falióra (Date.now()) eltolásához igazítunk.

import { performance } from 'node:perf_hooks';

const COARSE_MARGIN = 30; // ms
const MAX_CHUNK = 1000;   // ms
const DRIFT_LIMIT = 5;    // ms – ennél nagyobb eltérésnél (pl. NTP-igazítás) újrahangolja az órát

export function createClock() {
  let base = Date.now() - performance.now();
  return {
    now: () => base + performance.now(),
    recalibrate() {
      const fresh = Date.now() - performance.now();
      if (Math.abs(fresh - base) > DRIFT_LIMIT) base = fresh;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

/**
 * Megvárja a `target` (epoch ms) pillanatot, és visszaadja a tényleges időt.
 * @param {object} opts.clock   createClock() eredménye
 * @param {function} [opts.onTick] (hátralévő ms) – a durva fázisban kb. másodpercenként hívódik
 */
export async function waitUntil(target, { clock, onTick }) {
  for (;;) {
    const remaining = target - clock.now();
    if (remaining <= COARSE_MARGIN) break;
    await sleep(Math.min(remaining - COARSE_MARGIN, MAX_CHUNK));
    clock.recalibrate();
    onTick?.(target - clock.now());
  }
  while (clock.now() < target) await tick();
  return clock.now();
}
