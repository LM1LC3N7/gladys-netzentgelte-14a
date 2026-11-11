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
  assert.match(
    status(gladys).message.en,
    /2027: the file was refused \(unreadable data\); the data held stays in use\./,
  );
  assert.doesNotMatch(status(gladys).message.en, /failed/, 'not a failed check');
  assert.equal(app.years.get(2027).priced, 3);
  assert.equal(app.files[2027].etag, '"v1-2027"');
  // Not asked sooner, and not downloaded again while it does not change.
  source.requests.length = 0;
  await wait(DAY - MINUTE);
  assert.equal(source.requests.length, 0);
  await wait(MINUTE);
  const again = source.requests.find((r) => r.path === '2027.json');
  assert.equal(again.headers['If-None-Match'], '"broken"');
  assert.match(status(gladys).message.en, /2027: the file was refused/);
  // Fixed at the source: taken, the note goes.
  source.files['2027.json'] = yearFile(2027);
  source.etags['2027.json'] = '"v3-2027"';
  await wait(DAY);
  assert.equal(app.files[2027].etag, '"v3-2027"');
  assert.doesNotMatch(status(gladys).message.en, /refused/);
  // The list of years is needed: when it does not read, the check fails and is retried.
  source.files['jahre.json'] = 'not json';
  source.files['jahre.json'] = () => new Response('<html>', { status: 200 });
  await wait(DAY);
  assert.match(status(gladys).message.en, /Last check failed: unreadable data/);
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
  assert.equal(ack.data.costs[0].label, 'ST/HT', 'both quarters named');
  assert.equal(ack.data.costs[1].label, 'HT');
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

test('a year opened without sheets is "pending": the other years are still updated', async () => {
  const { source, wait, app, gladys, store } = await setup();
  // The source opens 2028 (every operator, no sheet) while 2027 turns final for 101.
  source.files['jahre.json'] = ['2028', '2027', '2026'];
  source.files['2028.json'] = yearFile(2027).map(({ pb: _pb, ...rest }) => rest);
  source.etags['2028.json'] = '"v1-2028"';
  source.files['2027.json'] = yearFile(2027, {
    101: (op) => ({ ...op, pb: { ...op.pb, status: 'endgueltig', m3_ht_ct_kwh: 15.1 } }),
  });
  source.etags['2027.json'] = '"v2-2027"';
  await wait(DAY);
  const op = app.years.get(2027).operators.find((o) => o.id === '101');
  assert.equal(op.prices.H, 15.1);
  assert.equal(op.provisional, false);
  assert.equal(app.years.has(2028), false);
  const text = status(gladys).message.en;
  assert.match(text, /2028: no sheet published yet\./);
  assert.doesNotMatch(text, /failed|refused/);
  assert.equal(store.data.failures, 0, 'no faster retry');
  assert.deepEqual(store.data.refused, { 2028: { etag: '"v1-2028"', issue: 'pending' } });
  // The next day: 2028 asked conditionally, not downloaded again.
  source.requests.length = 0;
  await wait(DAY);
  const asked = source.requests.find((r) => r.path === '2028.json');
  assert.equal(asked.headers['If-None-Match'], '"v1-2028"');
  // Kept across a restart too.
  await app.stop();
  const again = createSource();
  Object.assign(again.files, source.files);
  Object.assign(again.etags, source.etags);
  const restarted = await setup({ store, source: again, now: NOW + 3 * DAY + MINUTE });
  const after = again.requests.find((r) => r.path === '2028.json');
  assert.equal(after.headers['If-None-Match'], '"v1-2028"');
  assert.match(status(restarted.gladys).message.en, /2028: no sheet published yet/);
  await restarted.app.stop();
  await app.start();
  await wait(0);
  // Its sheets arrive: taken.
  source.files['2028.json'] = yearFile(2027);
  source.etags['2028.json'] = '"v2-2028"';
  await wait(DAY);
  assert.equal(app.years.get(2028).priced, 3);
  assert.doesNotMatch(status(gladys).message.en, /2028: no sheet/);
});

test('a year that fails on the network does not stop the others', async () => {
  const { source, wait, app, gladys, store } = await setup();
  source.files['2027.json'] = () => new Response('', { status: 503 });
  source.files['2026.json'] = yearFile(2026, {
    101: (op) => ({ ...op, pb: { ...op.pb, m3_nt_ct_kwh: 1.5 } }),
  });
  source.etags['2026.json'] = '"v2-2026"';
  await wait(DAY);
  assert.equal(app.years.get(2026).operators.find((o) => o.id === '101').prices.N, 1.5);
  assert.equal(app.years.get(2027).priced, 3, 'the held 2027 stays');
  assert.match(status(gladys).message.en, /Last check failed: the page is unavailable/);
  assert.equal(store.data.failures, 1);
  source.files['2027.json'] = yearFile(2027);
  await wait(5 * MINUTE);
  assert.equal(store.data.failures, 0);
});

test('the pricing never waits for the status: a hung status publication', async () => {
  const { app, gladys } = await setup();
  let calls = 0;
  gladys.setConnectionStatus = () => {
    calls += 1;
    return new Promise(() => {});
  };
  const unknown = { ...CONTRACT, id: 'c9', inputs: { operator: '999' } };
  const started = performance.now();
  const current = await app.energyCurrent({ contract: unknown });
  assert.equal(current.price, null);
  const known = await app.energyCurrent({ contract: CONTRACT });
  assert.ok(known.price > 0);
  await assert.rejects(app.energyPrice(priceRequest([['2026-01-15T16:00:00Z', 1]], unknown)));
  const costs = await app.energyPrice(priceRequest([['2026-01-15T16:00:00Z', 1]]));
  assert.equal(costs.length, 1);
  assert.ok(performance.now() - started < 1000, 'answered at once');
  assert.equal(calls, 1, 'one publication for the new state, never retried per call');
});

test('a failed status publication is not retried on every call', async () => {
  const { app, gladys, wait } = await setup();
  let calls = 0;
  gladys.setConnectionStatus = async () => {
    calls += 1;
    throw new Error('503');
  };
  const unknown = { ...CONTRACT, id: 'c9', inputs: { operator: '999' } };
  for (let i = 0; i < 5; i += 1) {
    await app.energyCurrent({ contract: unknown });
    await wait(0);
  }
  await wait(0);
  assert.equal(calls, 1);
  // A reconnection publishes it again.
  await app.stop();
  await app.start();
  await wait(0);
  assert.ok(calls >= 2, 'published again after a reconnection');
});

test('/data write that hangs: the check goes on, the status says so, stop ends', async () => {
  const store = createMemoryStore();
  store.save = () => new Promise(() => {});
  const { app, gladys, clock, source } = await setup({ store, start: false });
  // Not app.idle(): it would wait for the hung write itself.
  const advance = async (ms) => {
    await clock.advance(ms);
    await settle(30);
  };
  await app.start();
  await advance(0);
  await advance(10 * SECOND);
  await advance(10 * SECOND);
  assert.ok(source.count('2026.json') === 1, 'the check went on');
  assert.equal(app.years.size, 2);
  assert.match(status(gladys).message.en, /cannot be written to \/data/);
  let stopped = false;
  app.stop().then(() => (stopped = true));
  await advance(10 * SECOND);
  assert.equal(stopped, true);
});

test('the state file stays under the size read back: the oldest years left out', async () => {
  const source = createSource();
  // About 6 MB a year once serialised: three years do not fit in 16 MB.
  const padded = (year) =>
    yearFile(year).concat(
      Array.from({ length: 1500 }, (_, i) => ({
        vnb_id: String(5000 + i),
        name: `Netz ${i} ${'x'.repeat(150)}`,
        pb: { status: 'nicht_gefunden', hinweise: 'y'.repeat(3800) },
      })),
    );
  source.files['jahre.json'] = ['2028', '2027', '2026'];
  for (const y of [2026, 2027, 2028]) {
    source.files[`${y}.json`] = padded(y);
    source.etags[`${y}.json`] = `"big-${y}"`;
  }
  const { store, app, lines, gladys } = await setup({ source });
  assert.equal(app.years.size, 3, 'all in memory');
  const size = Buffer.byteLength(JSON.stringify(store.data));
  assert.ok(size < 16 * 1024 * 1024, `${size} bytes`);
  assert.deepEqual(Object.keys(store.data.years).sort(), ['2027', '2028']);
  assert.ok(lines.some((l) => /2026 not written to \/data/.test(l)));
  assert.match(status(gladys).message.en, /2026: kept in memory only/);
  assert.deepEqual(store.data.dropped, [2026]);
  await app.stop();
  // A restart: the left-out year is downloaded again at once, not a day later.
  const again = createSource();
  Object.assign(again.files, source.files);
  Object.assign(again.etags, source.etags);
  const second = await setup({ store, source: again, now: NOW + HOUR });
  assert.deepEqual(
    again.requests.map((r) => r.path),
    ['2026.json'],
  );
  assert.equal(second.app.years.size, 3);
  await second.app.stop();
  // Another restart within the hour: not again (a restart loop never repeats it).
  const third = createSource();
  Object.assign(third.files, source.files);
  const last = await setup({ store, source: third, now: NOW + HOUR + 10 * MINUTE });
  assert.equal(third.requests.length, 0);
  assert.equal(last.app.years.size, 2);
  await last.app.stop();
});

test('a 429 on one year: no other year is asked until the pause ends', async () => {
  const { source, wait } = await setup();
  source.files['2027.json'] = () =>
    new Response('', { status: 429, headers: { 'retry-after': '3600' } });
  source.requests.length = 0;
  await wait(DAY);
  assert.deepEqual(
    source.requests.map((r) => r.path),
    ['jahre.json', '2027.json'],
  );
  await wait(HOUR - MINUTE);
  assert.equal(source.requests.length, 2);
  source.files['2027.json'] = yearFile(2027);
  await wait(2 * MINUTE);
  assert.equal(source.count('2026.json'), 1);
});

test('a status publication that hangs does not hold the next ones', async () => {
  const { app, gladys, clock } = await setup();
  const sent = [];
  gladys.setConnectionStatus = (connected, message) => {
    sent.push(message?.en);
    return sent.length === 1 ? new Promise(() => {}) : Promise.resolve();
  };
  const unknown = { ...CONTRACT, id: 'c9', inputs: { operator: '999' } };
  await app.energyCurrent({ contract: unknown });
  await settle(10);
  assert.equal(sent.length, 1);
  await app.energyCurrent({ contract: { ...unknown, id: 'c10' } });
  await settle(10);
  assert.equal(sent.length, 1, 'waiting behind the hung one');
  await clock.advance(10 * SECOND);
  await settle(10);
  assert.equal(sent.length, 2, 'sent once the hung one is given up');
  assert.match(sent[1], /2 contract\(s\): grid operator not found/);
});

test('writes while one hangs are skipped, not piled up', async () => {
  const store = createMemoryStore();
  let calls = 0;
  store.save = () => {
    calls += 1;
    return new Promise(() => {});
  };
  const { app, clock } = await setup({ store, start: false });
  const advance = async (ms) => {
    await clock.advance(ms);
    await settle(30);
  };
  await app.start();
  await advance(0);
  await advance(10 * SECOND);
  await advance(DAY);
  await advance(10 * SECOND);
  await advance(10 * SECOND);
  assert.ok(app.years.size === 2);
  assert.equal(calls, 1, 'one write, the hung one');
  await app.stop();
});

test('a contract input out of bounds is told as such, not as an unknown operator', async () => {
  const contracts = [
    { ...CONTRACT, id: 'c2', inputs: { operator: '101', fixed_eur_month: 1200 } },
    { ...CONTRACT, id: 'c3', inputs: { operator: '101', vat_percent: '19,5' } },
  ];
  const { gladys } = await setup({ contracts });
  const text = status(gladys).message.en;
  assert.match(text, /2 contract\(s\): an input is not a number or out of bounds/);
  assert.doesNotMatch(text, /grid operator not found/);
  assert.match(status(gladys).message.fr, /2 contrat\(s\) : une entrée n’est pas un nombre/);
});
