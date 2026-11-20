// Opcionális kis HTTP felület: állapot lekérdezése és job kézi indítása.
//   GET  /            → a jobok állapota (JSON)
//   POST /run/<név>   → a job azonnali futtatása, a válasz az eredmény

import { createServer } from 'node:http';

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

export function startServer(scheduler, { port, host = '127.0.0.1' }, log) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/status')) {
        return send(res, 200, { now: new Date().toISOString(), jobs: scheduler.status() });
      }
      const run = /^\/run\/(.+)$/.exec(url.pathname);
      if (run && req.method === 'POST') {
        const name = decodeURIComponent(run[1]);
        const promise = scheduler.runNow(name);
        if (!promise) return send(res, 404, { error: `Nincs ilyen job: ${name}` });
        const result = await promise;
        if (!result) return send(res, 409, { error: 'A job éppen fut, ez a futás kimaradt' });
        return send(res, result.ok ? 200 : 502, result);
      }
      return send(res, 404, { error: 'Elérhető: GET /  ·  POST /run/<job neve>' });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  });
  server.on('error', (err) => log.error(`A státusz-szerver nem indult el (${host}:${port}): ${err.message}`));
  server.listen(port, host, () => log.info(`🌐 Státusz: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/  ·  kézi indítás: POST /run/<job neve>`));
  return server;
}
