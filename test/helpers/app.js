// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted Par14a-Database page and a
// virtual clock (each read moves it 1 µs).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../../src/app.js';
import { DATA_BASE_URL } from '../../src/constants.js';
import { createMemoryStore } from '../../src/store.js';
import { YEARS, yearFile } from '../fixtures/par14a.js';
import { testClock } from './clock.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Thursday 15 January 2026, 16:50 CET: ST for operator 101, HT at 17:15. */
export const NOW = Date.parse('2026-01-15T15:50:00Z');

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * The page: `files[path]` -> a body, or a function `(request) => Response |
 * body | 'timeout'`. The years answer with an ETag and honour If-None-Match.
 */
export function createSource() {
  const source = {
    requests: [],
    files: {
      'jahre.json': YEARS,
      '2026.json': yearFile(2026),
      '2027.json': yearFile(2027),
    },
    etags: { '2026.json': '"v1-2026"', '2027.json': '"v1-2027"' },
    lastModified: 'Sun, 01 Nov 2026 16:56:34 GMT',
    count: (path) => source.requests.filter((r) => r.path === path).length,
  };
  source.fetch = async (url, init = {}) => {
    const path = String(url).startsWith(`${DATA_BASE_URL}/`)
      ? String(url).slice(DATA_BASE_URL.length + 1)
      : String(url);
    const request = { url: String(url), path, headers: init.headers ?? {}, init };
    source.requests.push(request);
    let file = source.files[path];
    if (typeof file === 'function') file = await file(request);
    if (file === 'timeout') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (file instanceof Response) return file;
    if (file === undefined) return new Response('not found', { status: 404 });
    const etag = source.etags[path];
    if (etag && request.headers['If-None-Match'] === etag)
      return new Response(null, { status: 304 });
    return json(file, 200, {
      ...(etag ? { etag } : {}),
      'last-modified': source.lastModified,
    });
  };
  return source;
}

export const CONTRACT = {
  id: 'c1',
  template_key: 'de-14a-modul-3',
  inputs: { operator: '101', vat_percent: 19, supplement_ct_kwh: 0, fixed_eur_month: 0 },
  currency: 'EUR',
  timezone: 'Europe/Berlin',
  billing_period_start_day: 1,
};

export async function setup({
  store = createMemoryStore(),
  source = createSource(),
  now = NOW,
  contracts = [CONTRACT],
  start = true,
} = {}) {
  const gladys = createFakeGladys({ selector: 'netzentgelte-14a', energyContracts: contracts });
  await gladys.connect();
  const clock = testClock({ start: now });
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new App({
    gladys,
    logger: { info: log, warn: log, error: log, debug: log },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    fetchImpl: source.fetch,
  });
  gladys.onEnergyPrice((request) => app.energyPrice(request));
  gladys.onEnergyCurrent((request) => app.energyCurrent(request));
  gladys.onAction('find_operator', (fields) => app.findOperator(fields));
  const wait = async (ms) => {
    await clock.advance(ms);
    await app.idle();
  };
  if (start) {
    await app.start();
    await wait(0);
  }
  return { app, gladys, clock, store, source, wait, lines };
}

/** The pricing request of the core for `intervals` (`[[starts_at, kwh]]`). */
export const priceRequest = (intervals, contract = CONTRACT) => ({
  contract,
  billing_period: { starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-02-01T00:00:00Z' },
  cumulative_before: { day: 0, month: 0, billing_period: 0 },
  intervals: intervals.map(([starts_at, kwh]) => ({ starts_at, kwh, max_power_kw: 1 })),
});
