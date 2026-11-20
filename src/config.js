// A jobs.json beolvasása és ellenőrzése.

import { readFileSync } from 'node:fs';
import { createSchedule } from './schedule.js';
import { parseDuration } from './util.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export class ConfigError extends Error {
  constructor(problems) {
    super(`A konfiguráció hibás:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    throw new ConfigError([`Nem olvasható a fájl: ${path} (${err.code || err.message})`]);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (err) {
    throw new ConfigError([`Hibás JSON: ${err.message}`]);
  }
  validate(config);
  return config;
}

function checkDuration(value, where, problems) {
  if (value === undefined) return;
  try { parseDuration(value); } catch (err) { problems.push(`${where}: ${err.message}`); }
}

export function validate(config) {
  const problems = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigError(['A fájl gyökere egy objektum legyen: { "jobs": [ ... ] }']);
  }
  if (!Array.isArray(config.jobs)) problems.push('Hiányzik a "jobs" tömb');
  if (config.server !== undefined) {
    const port = config.server?.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('server.port: 1 és 65535 közötti egész szám legyen');
  }
  checkDuration(config.defaults?.timeout, 'defaults.timeout', problems);
  checkDuration(config.defaults?.retryDelay, 'defaults.retryDelay', problems);

  const names = new Set();
  (config.jobs || []).forEach((job, i) => {
    const where = `jobs[${i}]${job?.name ? ` ("${job.name}")` : ''}`;
    if (!job || typeof job !== 'object') { problems.push(`${where}: objektum legyen`); return; }
    if (!job.name || typeof job.name !== 'string') problems.push(`${where}: kötelező a "name"`);
    else if (names.has(job.name)) problems.push(`${where}: a "${job.name}" név többször szerepel`);
    else names.add(job.name);

    try { createSchedule(job.schedule); } catch (err) { problems.push(`${where}.schedule: ${err.message}`); }

    if (!Array.isArray(job.requests) || job.requests.length === 0) {
      problems.push(`${where}: a "requests" legalább egy kérést tartalmazzon`);
      return;
    }
    job.requests.forEach((req, j) => {
      const rw = `${where}.requests[${j}]`;
      if (!req || typeof req !== 'object') { problems.push(`${rw}: objektum legyen`); return; }
      if (!req.url || typeof req.url !== 'string') problems.push(`${rw}: kötelező az "url"`);
      if (req.method && !METHODS.includes(String(req.method).toUpperCase())) {
        problems.push(`${rw}: ismeretlen method "${req.method}" (${METHODS.join(', ')})`);
      }
      if (req.body !== undefined && req.form !== undefined) problems.push(`${rw}: "body" és "form" egyszerre nem adható meg`);
      if (req.save !== undefined && (typeof req.save !== 'object' || Array.isArray(req.save))) {
        problems.push(`${rw}: a "save" objektum legyen, pl. { "token": "body.access_token" }`);
      }
      checkDuration(req.delayAfter, `${rw}.delayAfter`, problems);
      checkDuration(req.timeout, `${rw}.timeout`, problems);
      checkDuration(req.retryDelay, `${rw}.retryDelay`, problems);
    });
  });

  if (problems.length) throw new ConfigError(problems);
}
