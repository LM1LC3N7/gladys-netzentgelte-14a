// -----------------------------------------------------------------------------
// The real clock (performance.now, setTimeout) sped up 100,000 times and a
// real local HTTP server: the checks come once a day, never sooner, and the
// conditional request is really sent. Wide margins: a timer is late under
// load, never early.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../src/app.js';
import { CHECK_EVERY, DATA_BASE_URL } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { YEARS, yearFile } from './fixtures/par14a.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';

test('real clock: one check a day, conditional, nothing after stop', async (t) => {
  const requests = [];
  const files = {
    '/jahre.json': YEARS,
    '/2026.json': yearFile(2026),
    '/2027.json': yearFile(2027),
  };
  const server = createServer((req, res) => {
    requests.push({ path: req.url, etag: req.headers['if-none-match'] });
    const body = files[req.url];
    if (!body) return res.writeHead(404).end();
    const etag = req.url === '/jahre.json' ? undefined : `"${req.url}"`;
    if (etag && req.headers['if-none-match'] === etag) return res.writeHead(304).end();
    res.writeHead(200, { 'content-type': 'application/json', ...(etag ? { etag } : {}) });
    return res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const clock = realClock({ speed: 100_000 });
  const gladys = createFakeGladys({ selector: 'netzentgelte-14a' });
  await gladys.connect();
  const app = new App({
    gladys,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    fetchImpl: (url, init) =>
      fetch(String(url).replace(DATA_BASE_URL, base), {
        ...init,
        signal: AbortSignal.timeout(5000),
      }),
  });
  t.after(async () => {
    await app.stop();
    clock.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const spy = spyOn(app, 'runCheck', clock);
  await app.start();
  await measurePeriod(spy, { count: 3, period: CHECK_EVERY, timeoutMs: 20_000 });
  await app.idle();
  assert.equal(app.years.size, 2);
  const later = requests.filter((r) => r.path === '/2027.json').slice(1);
  assert.ok(later.length >= 2);
  assert.ok(
    later.every((r) => r.etag === '"/2027.json"'),
    'the later checks are conditional',
  );
  await app.stop();
  const count = requests.length;
  const timers = clock.timersSet;
  await clock.sleep(2 * CHECK_EVERY);
  assert.equal(requests.length, count, 'no request after stop');
  assert.equal(clock.timersSet, timers, 'no timer after stop');
});
