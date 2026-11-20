// Egy job kéréssorozatának végrehajtása: behelyettesítés, küldés, újrapróbálás, értékek mentése.

import { render } from './template.js';
import { getPath, parseDuration, sleep, truncate } from './util.js';

function isExpected(status, expect) {
  if (expect === undefined) return status >= 200 && status < 300;
  const list = Array.isArray(expect) ? expect : [expect];
  return list.some((e) => (typeof e === 'string' && /^\dxx$/i.test(e) ? Math.floor(status / 100) === Number(e[0]) : Number(e) === status));
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function buildRequest(step, scope, settings, missing) {
  const method = String(step.method || (step.body !== undefined || step.form !== undefined ? 'POST' : 'GET')).toUpperCase();
  const url = new URL(String(render(step.url, scope, missing)));
  if (step.query) {
    for (const [k, v] of Object.entries(render(step.query, scope, missing))) url.searchParams.append(k, String(v));
  }
  const rawHeaders = render({ ...settings.headers, ...step.headers }, scope, missing);
  const headers = Object.fromEntries(Object.entries(rawHeaders).map(([k, v]) => [k, String(v)]));

  let body;
  if (step.form !== undefined) {
    const form = render(step.form, scope, missing);
    body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString();
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (step.body !== undefined) {
    const rendered = render(step.body, scope, missing);
    if (typeof rendered === 'string') {
      body = rendered;
    } else {
      body = JSON.stringify(rendered);
      if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
    }
  }
  return { method, url: url.toString(), headers, body };
}

async function sendOnce(req, timeoutMs) {
  const started = Date.now();
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  const text = await res.text();
  let body = text;
  if (text) {
    try { body = JSON.parse(text); } catch { /* nem JSON, marad szöveg */ }
  }
  return {
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers),
    body,
    text,
    durationMs: Date.now() - started,
  };
}

function describeError(err) {
  if (err?.name === 'TimeoutError') return 'időtúllépés';
  const cause = err?.cause;
  if (cause?.code) return `${cause.code}${cause.message ? ` – ${cause.message}` : ''}`;
  return err?.message || String(err);
}

/**
 * Lefuttatja a job összes kérését sorban.
 * @returns {Promise<{ok: boolean, startedAt: Date, durationMs: number, steps: object[]}>}
 */
export async function runJob(job, config, log, reason = 'kézi') {
  const defaults = config.defaults || {};
  const settings = {
    timeout: job.timeout ?? defaults.timeout ?? '30s',
    retries: job.retries ?? defaults.retries ?? 0,
    retryDelay: job.retryDelay ?? defaults.retryDelay ?? '5s',
    headers: { ...defaults.headers, ...job.headers },
    logBody: job.logResponseBody ?? defaults.logResponseBody ?? 300,
  };
  const vars = { ...config.variables, ...job.variables };
  const responses = {};
  let last;
  const scope = () => ({ ...vars, responses, last, env: process.env });

  const startedAt = new Date();
  const total = job.requests.length;
  log.title(`▶ ${job.name} – indul (${reason}), ${total} kérés`);

  const steps = [];
  let ok = true;
  for (let i = 0; i < total; i++) {
    const step = job.requests[i];
    const label = `${job.name} › ${step.name || `${i + 1}/${total}`}`;
    const missing = new Set();
    let req;
    try {
      req = buildRequest(step, scope(), settings, missing);
    } catch (err) {
      log.error(`  ✗ ${label} nem állítható össze a kérés: ${err.message}`);
      steps.push({ name: label, ok: false, error: err.message });
      ok = false;
      if (job.stopOnError !== false) break;
      continue;
    }
    if (missing.size) log.warn(`  ! ${label} ismeretlen változó(k): ${[...missing].join(', ')}`);

    const timeoutMs = parseDuration(step.timeout ?? settings.timeout);
    const retries = step.retries ?? settings.retries;
    const retryDelayMs = parseDuration(step.retryDelay ?? settings.retryDelay);

    let result;
    let error;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const tryText = attempt ? ` (újrapróbálás ${attempt}/${retries})` : '';
      try {
        result = await sendOnce(req, timeoutMs);
        error = undefined;
        if (isExpected(result.status, step.expectStatus)) {
          log.ok(`  ✓ ${label} ${req.method} ${req.url} → ${result.status} ${result.statusText} (${result.durationMs} ms)${tryText}`);
          break;
        }
        error = `nem várt státusz: ${result.status} ${result.statusText}`;
        log.warn(`  ✗ ${label} ${req.method} ${req.url} → ${result.status} ${result.statusText} (${result.durationMs} ms)${tryText}`);
      } catch (err) {
        result = undefined;
        error = describeError(err);
        log.warn(`  ✗ ${label} ${req.method} ${req.url} → hiba: ${error}${tryText}`);
      }
      if (attempt < retries) await sleep(retryDelayMs);
    }

    if (result && settings.logBody && result.text) log.detail(`      ${truncate(result.text, Number(settings.logBody) || 300)}`);

    const stepOk = !error;
    steps.push({
      name: label, ok: stepOk, method: req.method, url: req.url,
      status: result?.status, durationMs: result?.durationMs, error,
    });

    if (result) {
      last = { status: result.status, headers: result.headers, body: result.body };
      if (step.name) responses[step.name] = last;
    }

    if (stepOk && step.save) {
      for (const [varName, path] of Object.entries(step.save)) {
        const value = getPath(last, path);
        if (value === undefined) log.warn(`  ! ${label} save: "${path}" nem található a válaszban (${varName})`);
        else vars[varName] = value;
      }
    }

    if (!stepOk) {
      ok = false;
      if (job.stopOnError !== false) {
        if (i < total - 1) log.warn(`  ■ a sorozat megáll (${total - i - 1} kérés kimarad) – "stopOnError": false esetén folytatná`);
        break;
      }
    }

    if (step.delayAfter && i < total - 1) await sleep(parseDuration(step.delayAfter));
  }

  const durationMs = Date.now() - startedAt.getTime();
  const done = steps.filter((s) => s.ok).length;
  if (ok) log.ok(`■ ${job.name} – kész: ${done}/${total} sikeres (${durationMs} ms)`);
  else log.error(`■ ${job.name} – hibával zárult: ${done}/${total} sikeres (${durationMs} ms)`);

  return { ok, startedAt, durationMs, steps };
}
