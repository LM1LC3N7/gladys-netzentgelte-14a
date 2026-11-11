// -----------------------------------------------------------------------------
// The app: downloads, schedule, /data, status, delegated pricing through the
// fake Gladys, the search button. Virtual clock, scripted source.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { USER_AGENT } from '../src/constants.js';
import { yearFile } from './fixtures/par14a.js';
import { settle } from './helpers/clock.js';
import {
  CONTRACT,
  DAY,
  HOUR,
  MINUTE,
  NOW,
  SECOND,
  createSource,
  json,
  priceRequest,
  setup,
} from './helpers/app.js';

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const status = (gladys) => gladys.fake.connectionStatus;

test('first start: the years downloaded, kept in /data, the status dates them', async () => {
  const { app, gladys, source, store } = await setup();
  assert.deepEqual(
    source.requests.map((r) => r.path),
    ['jahre.json', '2027.json', '2026.json'],
  );
  for (const r of source.requests) {
    assert.equal(r.headers['User-Agent'], USER_AGENT);
    assert.equal(r.headers.Accept, 'application/json');
    assert.equal(r.headers['If-None-Match'], undefined, 'nothing held yet');
    assert.equal(r.init.redirect, 'error');
    assert.ok(r.init.signal, 'a timeout');
  }
  assert.match(
    USER_AGENT,
    /^gladys-netzentgelte-14a\/0\.1\.0 \(\+https:\/\/github\.com\/LM1LC3N7\//,
  );
  assert.deepEqual(Object.keys(store.data.years).sort(), ['2026', '2027']);
  assert.equal(store.data.years['2027'].etag, '"v1-2027"');
  assert.equal(
    store.data.attemptAt,
    store.data.checkedAt === undefined ? undefined : store.data.attemptAt,
  );
  assert.ok(store.data.checkedAt >= NOW);
  const s = status(gladys);
  assert.equal(s.connected, true);
  assert.match(s.message.en, /Par14a-Database \(the78mole\), CC BY 4\.0/);
  assert.match(s.message.en, /2027: 3 operators, PROVISIONAL; 2026: 3 operators, final/);
  assert.match(s.message.en, /Data published on 2026-11-01/);
  assert.match(s.message.en, /Checked 2026-01-15 16:50 \(German time\)/);
  assert.match(s.message.fr, /2027 : 3 gestionnaires, PROVISOIRES/);
  assert.equal(gladys.fake.connectionStatuses[0].connected, false, 'starting first');
  assert.equal(app.years.size, 2);
});

test('the attempt is dated in /data before the first request', async () => {
  const store = createMemoryStore();
  const source = createSource();
  let seen;
  source.files['jahre.json'] = () => {
    seen = store.data?.attemptAt;
    return ['2026'];
  };
  await setup({ store, source });
  assert.ok(seen >= NOW && seen < NOW + SECOND);
});

test('a check a day, conditional: an unchanged year is not downloaded again', async () => {
  const { source, wait, store } = await setup();
  source.requests.length = 0;
  await wait(DAY - MINUTE);
  assert.equal(source.requests.length, 0, 'not before a day');
  await wait(MINUTE);
  assert.deepEqual(
    source.requests.map((r) => [r.path, r.headers['If-None-Match']]),
    [
      ['jahre.json', undefined],
      ['2027.json', '"v1-2027"'],
      ['2026.json', '"v1-2026"'],
    ],
  );
  assert.equal(store.data.years['2027'].etag, '"v1-2027"', 'kept on 304');
  // A changed file replaces the held one.
  source.files['2027.json'] = yearFile(2027, {
    101: (op) => ({ ...op, pb: { ...op.pb, m3_nt_ct_kwh: 4 } }),
  });
  source.etags['2027.json'] = '"v2-2027"';
  await wait(DAY);
  assert.equal(store.data.years['2027'].etag, '"v2-2027"');
});

test('a restart reads /data and never checks before the day is over', async () => {
  const first = await setup();
  const store = first.store;
  await first.app.stop();
  const source = createSource();
  const { app, gladys, wait } = await setup({ store, source, now: NOW + 5 * HOUR });
  assert.equal(source.requests.length, 0, 'served from /data');
  assert.equal(app.years.size, 2);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.en, /Checked 2026-01-15 16:50/);
  await wait(19 * HOUR - MINUTE);
  assert.equal(source.requests.length, 0);
  await wait(2 * MINUTE);
  assert.equal(source.count('jahre.json'), 1, 'checked once the day is over');
  // Pricing works from /data alone.
  const ack = await gladys.fake.energyPrice(priceRequest([['2026-01-15T16:00:00Z', 1]]));
  assert.equal(ack.success, true);
});

test('a date from the future in /data is not trusted: checked now', async () => {
  const first = await setup();
  const store = first.store;
  await first.app.stop();
  const source = createSource();
  await setup({ store, source, now: NOW - DAY });
  assert.equal(source.count('jahre.json'), 1);
});

test('a reconnection to Gladys neither downloads nor loses the schedule', async () => {
  const { app, source, gladys, wait } = await setup();
  source.requests.length = 0;
  const before = gladys.fake.connectionStatuses.length;
  await app.stop();
  await app.start();
  await wait(0);
  assert.equal(source.requests.length, 0);
  assert.ok(gladys.fake.connectionStatuses.length > before, 'the status is published again');
  await wait(DAY);
  assert.equal(source.count('jahre.json'), 1, 'the daily check still runs');
});

test('a reconnection during a check: the schedule resumes after it', async () => {
  const source = createSource();
  let release;
  source.files['2026.json'] = () =>
    new Promise((resolve) => {
      release = () => resolve(yearFile(2026));
    });
  const { app, wait, clock } = await setup({ source, start: false });
  await app.start();
  await clock.advance(0);
  await settle(20);
  assert.ok(release, 'the check waits on 2026');
  app.stop();
  const restarted = app.start();
  source.files['2026.json'] = yearFile(2026);
  release();
  await restarted;
  await wait(0);
  assert.ok(app.timer, 'a next check is scheduled');
  source.requests.length = 0;
  await wait(DAY + MINUTE);
  assert.ok(source.count('jahre.json') >= 1);
});

test('5xx and network errors: retried after 5, 15, 30, 60 minutes, the data held stays', async () => {
  const { source, gladys, wait, store, app } = await setup();
  source.files['jahre.json'] = () => new Response('down', { status: 503 });
  source.requests.length = 0;
  await wait(DAY);
  assert.equal(source.count('jahre.json'), 1);
  assert.match(
    status(gladys).message.en,
    /Last check failed: the page is unavailable \(5xx\); next try 2026-01-16 16:55\./,
  );
  assert.equal(status(gladys).connected, true, 'the data held still prices');
  assert.equal(store.data.failures, 1);
  for (const [gap, total] of [
    [5 * MINUTE, 2],
    [15 * MINUTE, 3],
    [30 * MINUTE, 4],
    [60 * MINUTE, 5],
  ]) {
    await wait(gap - SECOND);
    assert.equal(source.count('jahre.json'), total - 1, `not before ${gap / MINUTE} min`);
    await wait(SECOND);
    assert.equal(source.count('jahre.json'), total, `after ${gap / MINUTE} min`);
  }
  source.files['jahre.json'] = 'timeout';
  await wait(3 * HOUR);
  assert.match(status(gladys).message.en, /no answer in time/);
  source.files['jahre.json'] = ['2027', '2026'];
  await wait(3 * HOUR);
  assert.equal(store.data.failures, 0);
  assert.doesNotMatch(status(gladys).message.en, /failed/);
  assert.equal(app.years.size, 2);
});

test('a 429 pauses with its Retry-After (bounded), kept across a restart', async () => {
  const { source, store, app, wait } = await setup();
  source.files['jahre.json'] = () =>
    new Response('', { status: 429, headers: { 'retry-after': '7200' } });
  await wait(DAY);
  const paused = store.data.pausedUntil;
  assert.ok(Math.abs(paused - (NOW + DAY + 2 * HOUR)) < SECOND);
  await app.stop();
  // Restart one hour later: still paused, nothing asked until the end.
  const again = createSource();
  const second = await setup({ store, source: again, now: NOW + DAY + HOUR });
  assert.equal(again.requests.length, 0);
  await second.wait(HOUR - MINUTE);
  assert.equal(again.requests.length, 0);
  await second.wait(2 * MINUTE);
  assert.equal(again.count('jahre.json'), 1);
  // Without Retry-After: 10 minutes; a huge one: 6 hours at most.
  const third = await setup();
  third.source.files['jahre.json'] = () => new Response('', { status: 429 });
  await third.wait(DAY);
  assert.ok(Math.abs(third.store.data.pausedUntil - (NOW + DAY + 10 * MINUTE)) < SECOND);
  third.source.files['jahre.json'] = () =>
    new Response('', { status: 429, headers: { 'retry-after': '999999' } });
  await third.wait(10 * MINUTE);
  assert.ok(Math.abs(third.store.data.pausedUntil - (NOW + DAY + 10 * MINUTE + 6 * HOUR)) < SECOND);
});

test('a new file that does not read is refused whole: the held year stays', async () => {
  const { source, wait, app, gladys } = await setup();
  source.files['2027.json'] = [{ nothing: true }];
  source.etags['2027.json'] = '"broken"';
  await wait(DAY);
  assert.match(status(gladys).message.en, /unreadable data/);
  assert.equal(app.years.get(2027).priced, 3);
  assert.equal(app.files[2027].etag, '"v1-2027"', 'the old ETag: the broken file is asked again');
  source.files['jahre.json'] = 'not json';
  source.files['jahre.json'] = () => new Response('<html>', { status: 200 });
  await wait(5 * MINUTE);
  assert.match(status(gladys).message.en, /unreadable data/);
  source.files['jahre.json'] = () => json({ years: [] });
  await wait(15 * MINUTE);
  assert.match(status(gladys).message.en, /unreadable data/);
  source.files['jahre.json'] = () => new Response('', { status: 404 });
  await wait(30 * MINUTE);
  assert.match(status(gladys).message.en, /a file is missing \(404\)/);
  source.files['jahre.json'] = () => new Response('', { status: 302, headers: { location: 'x' } });
  await wait(60 * MINUTE);
  assert.match(status(gladys).message.en, /unexpected HTTP answer/);
});

test('an oversized answer is cut before it is read whole', async () => {
  const source = createSource();
  let pulled = 0;
  source.files['2027.json'] = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          if (pulled > 1000) controller.close();
          else controller.enqueue(new Uint8Array(64 * 1024));
        },
      }),
      { status: 200 },
    );
  const { gladys, app } = await setup({ source });
  assert.match(status(gladys).message.en, /answer too large/);
  assert.ok(pulled < 200, `stopped early (${pulled} chunks)`);
  assert.equal(app.years.has(2027), false);
  // A declared length over the bound is refused before reading.
  const declared = createSource();
  declared.files['jahre.json'] = () =>
    new Response('[]', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } });
  const second = await setup({ source: declared });
  assert.match(status(second.gladys).message.en, /answer too large/);
});

test('/data unreadable: nothing downloaded, read again every 10 s', async () => {
  const store = createMemoryStore({ attemptAt: NOW - HOUR });
  store.unreadable = true;
  const source = createSource();
  const { gladys, wait, app } = await setup({ store, source });
  assert.equal(source.requests.length, 0);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /cannot be read: read again every 10 seconds/);
  await wait(30 * SECOND);
  assert.equal(source.requests.length, 0, 'still nothing downloaded');
  assert.equal(store.saves, 0, 'never overwritten');
  store.unreadable = false;
  await wait(10 * SECOND);
  assert.equal(app.loaded, true);
  // /data said: attempted an hour ago, so the check waits for the rest of the day.
  assert.equal(source.requests.length, 0);
  await wait(23 * HOUR);
  assert.equal(source.count('jahre.json'), 1);
});

test('/data not writable: the data works from memory, no faster checks', async () => {
  const store = createMemoryStore();
  store.failSave = true;
  const { source, wait, gladys, lines } = await setup({ store });
  assert.equal(status(gladys).connected, true);
  assert.ok(lines.some((l) => /Could not write \/data/.test(l)));
  source.requests.length = 0;
  await wait(DAY - MINUTE);
  assert.equal(source.requests.length, 0);
});

test('stored data that does not read is dropped and downloaded again', async () => {
  const store = createMemoryStore({
    attemptAt: NOW - HOUR,
    checkedAt: NOW - HOUR,
    failures: 'x',
    pausedUntil: NOW + 100 * DAY,
    years: { 2027: { etag: '"v1-2027"', json: [{}] }, 2026: { json: yearFile(2026) }, 1999: {} },
  });
  const { app, source, wait } = await setup({ store });
  assert.deepEqual([...app.years.keys()], [2026]);
  assert.equal(app.meta.pausedUntil, undefined, 'a pause over 6 hours is not ours');
  assert.equal(app.meta.failures, 0);
  await wait(23 * HOUR);
  assert.equal(source.requests[1].headers['If-None-Match'], undefined, '2027 asked whole');
});

test('no timer, no request after stop', async () => {
  const { app, clock, source, wait } = await setup();
  await app.stop();
  assert.equal(clock.pending, 0);
  source.requests.length = 0;
  await wait(3 * DAY);
  assert.equal(source.requests.length, 0);
});

test('delegated pricing through Gladys: costs per half hour, label, failure = no cost', async () => {
  const { gladys } = await setup();
  const ack = await gladys.fake.energyPrice(
    priceRequest([
      ['2026-01-15T16:00:00Z', 1],
      ['2026-01-15T16:30:00Z', 2],
    ]),
  );
  assert.equal(ack.success, true, JSON.stringify(ack));
  close(ack.data.costs[0].cost, (0.5 * 0.08 + 0.5 * 0.12) * 1.19);
  close(ack.data.costs[1].cost, 2 * 0.12 * 1.19);
  assert.equal(ack.data.costs[0].label, 'HT');
  const empty = await gladys.fake.energyPrice(priceRequest([]));
  assert.equal(empty.success, true);
  const unknown = await gladys.fake.energyPrice(
    priceRequest([['2026-01-15T16:00:00Z', 1]], {
      ...CONTRACT,
      id: 'c2',
      inputs: { operator: '999' },
    }),
  );
  assert.equal(unknown.success, false);
  assert.match(status(gladys).message.en, /1 contract\(s\): grid operator not found/);
  const missingYear = await gladys.fake.energyPrice(priceRequest([['2025-06-01T10:00:00Z', 1]]));
  assert.equal(missingYear.success, false, 'no data for 2025: no cost, the core retries');
});

test('the current price for the dashboard and the scenes', async () => {
  const { gladys } = await setup();
  const ack = await gladys.fake.energyCurrent({
    contract: CONTRACT,
    billing_period: {},
    cumulative: {},
    max_power_kw: 0,
  });
  assert.equal(ack.success, true);
  close(ack.data.price, 0.08 * 1.19);
  assert.equal(ack.data.valid_until, '2026-01-15T16:15:00.000Z');
  close(ack.data.next_price, 0.12 * 1.19);
  assert.equal(ack.data.label, 'ST, 2025-12-20');
  const unknown = await gladys.fake.energyCurrent({
    contract: { ...CONTRACT, inputs: { operator: 'nobody' } },
    billing_period: {},
    cumulative: {},
    max_power_kw: 0,
  });
  assert.equal(unknown.success, true);
  assert.equal(unknown.data.price, null, 'unknown, never 0');
});

test('the contracts are checked at start; reading them may fail without harm', async () => {
  const contracts = [
    CONTRACT,
    { ...CONTRACT, id: 'c2', inputs: { operator: 'Musterstadt' } },
    { ...CONTRACT, id: 'c3', inputs: { operator: '103' } },
    { ...CONTRACT, id: 'c4', template_key: 'other', inputs: {} },
  ];
  const { gladys } = await setup({ contracts });
  assert.match(status(gladys).message.en, /1 contract\(s\): grid operator not found/);
  assert.match(
    status(gladys).message.en,
    /1 contract\(s\): the sheet notes HT\/NT on working days only/,
  );
  const failing = await setup({ start: false });
  failing.gladys.getEnergyContracts = async () => {
    throw new Error('503');
  };
  await failing.app.start();
  await failing.wait(0);
  assert.equal(status(failing.gladys).connected, true);
  assert.ok(failing.lines.some((l) => /Contracts not read/.test(l)));
});

test('the search button: ID, name, town; the query never repeated back', async () => {
  const { gladys } = await setup();
  const found = await gladys.fake.action('find_operator', { query: 'musterstadt' });
  assert.equal(found.success, true);
  const { en, fr } = found.data.message;
  assert.match(
    en,
    /Musterstadt Netz GmbH \(10115 Berlin\) – ID 101: 2026 sheet final, read 2025-12-20, HT 12\.00 \/ ST 8\.00 \/ NT 2\.00 ct\/kWh net, Modul 3 in Q1, Q4\./,
  );
  assert.match(en, /ID 103: .*working days/);
  assert.match(
    fr,
    /ID 101 : grille 2026 définitive, relevée le 2025-12-20, HT 12\.00 \/ ST 8\.00 \/ NT 2\.00 ct\/kWh hors TVA, Modul 3 en T1, T4\./,
  );
  assert.match(en, /Source: Par14a-Database \(the78mole\), CC BY 4\.0/);
  const broken = await gladys.fake.action('find_operator', { query: '104' });
  assert.match(broken.data.message.en, /no usable Modul 3 tariff for 2026 \(overlapping windows\)/);
  const none = await gladys.fake.action('find_operator', { query: 'Zzyzx<script>' });
  assert.match(none.data.message.en, /No grid operator found/);
  assert.doesNotMatch(none.data.message.en, /Zzyzx|script/);
  const empty = await gladys.fake.action('find_operator', { query: '  ' });
  assert.match(empty.data.message.en, /Type part of the operator name/);
  const many = await setup({
    source: Object.assign(createSource(), {}),
  });
  const big = Array.from({ length: 15 }, (_, i) => ({
    ...yearFile(2026)[0],
    vnb_id: String(200 + i),
    name: `Netz ${i} GmbH`,
  }));
  many.source.files['2026.json'] = big;
  many.source.etags['2026.json'] = '"big"';
  await many.wait(DAY);
  const more = await many.gladys.fake.action('find_operator', { query: 'netz' });
  assert.equal(more.data.message.en.split('\n').length, 12, '10 operators, "more", the source');
  assert.match(more.data.message.en, /More operators match/);
});

test('the search before any data, and in a year without data the latest one', async () => {
  const source = createSource();
  source.files['jahre.json'] = () => new Response('', { status: 503 });
  const { gladys } = await setup({ source });
  const none = await gladys.fake.action('find_operator', { query: 'netz' });
  assert.match(none.data.message.en, /No Par14a-Database data yet/);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /No data yet\. Last check failed/);
  // In 2028 with only 2026 and 2027: the 2027 sheets are shown.
  const later = await setup({ now: Date.parse('2028-02-01T10:00:00Z') });
  const found = await later.gladys.fake.action('find_operator', { query: '101' });
  assert.match(found.data.message.en, /2027 sheet provisional, read 2026-10-28, HT 13\.00/);
});
