// -----------------------------------------------------------------------------
// The data file read and the delegated pricing: windows on the quarter-hour
// grid, quarters, Berlin time and its clock changes, the year boundary, the
// inputs. Pure functions, no clock, no network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DataError,
  normalize,
  parseYear,
  parseYears,
  quarterLevels,
  resolveOperator,
  searchOperators,
  windowSlots,
} from '../src/data.js';
import { PricingError, contractInputs, currentPrice, intervalCosts } from '../src/tariff.js';
import { yearFile } from './fixtures/par14a.js';

const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} != ${expected}`);

const data = (...years) => ({
  years: new Map(years.map((y) => [y, parseYear(yearFile(y))])),
});
const contract = (operator, inputs = {}) => ({
  id: 'c1',
  template_key: 'de-14a-modul-3',
  inputs: { operator, vat_percent: 0, supplement_ct_kwh: 0, ...inputs },
});
const price = (d, c, starts_at, kwh = 1) => intervalCosts(d, c, [{ starts_at, kwh }])[0];

test('windows: quarter-hour grid, 24:00, across midnight; anything else refused', () => {
  assert.deepEqual(windowSlots('17:15-18:00'), [69, 70, 71]);
  assert.deepEqual(windowSlots('23:30-24:00'), [94, 95]);
  assert.deepEqual(windowSlots('23:30-00:30'), [94, 95, 0, 1]);
  // A whole day (a sheet with NT all day in summer, Verteilnetz Plauen).
  assert.equal(windowSlots('00:00-24:00').length, 96);
  assert.equal(quarterLevels({ ht: [], nt: ['00:00-24:00'] }), 'N'.repeat(96));
  for (const bad of ['17:10-18:00', '7:00-8:00', '24:00-01:00', '10:00-10:00', '', null, 17]) {
    assert.throws(() => windowSlots(bad), DataError, String(bad));
  }
  const levels = quarterLevels({ ht: ['17:00-18:00'], nt: ['23:00-02:00'] });
  assert.equal(levels.length, 96);
  assert.equal(levels[68], 'H');
  assert.equal(levels[72], 'S');
  assert.equal(levels[95], 'N');
  assert.equal(levels[7], 'N');
  assert.equal(levels[8], 'S');
  assert.throws(() => quarterLevels({ ht: ['17:00-18:00'], nt: ['17:45-19:00'] }), /overlapping/);
  assert.throws(() => quarterLevels({ ht: ['17:00-18:00', '17:30-17:45'] }), /overlapping/);
  assert.throws(() => quarterLevels({ ht: '17:00-18:00' }), DataError);
});

test('the year file: operators checked one by one, a broken one kept for the search only', () => {
  const year = parseYear(yearFile(2026));
  assert.equal(year.operators.length, 5);
  assert.equal(year.priced, 3);
  assert.equal(year.provisional, 0);
  const byId = Object.fromEntries(year.operators.map((op) => [op.id, op]));
  assert.equal(byId['104'].error, 'overlapping windows');
  assert.equal(byId['105'].error, 'no price sheet');
  assert.equal(byId['101'].quarters[1], null, 'Q2 outside Modul 3');
  assert.equal(byId['101'].prices.STD, 8);
  assert.equal(byId['103'].weekdaysNote, true);
  assert.equal(byId['101'].weekdaysNote, undefined);
  assert.equal(parseYear(yearFile(2027)).provisional, 3);

  const broken = (change) => parseYear(yearFile(2026, { 101: change })).operators[0].error;
  assert.equal(
    broken((op) => ({ ...op, pb: { ...op.pb, m3_ht_ct_kwh: '12' } })),
    'no Modul 3 prices',
  );
  assert.equal(
    broken((op) => ({ ...op, pb: { ...op.pb, m3_nt_ct_kwh: 250 } })),
    'no Modul 3 prices',
  );
  assert.equal(
    broken((op) => ({ ...op, pb: { ...op.pb, m3_st_ct_kwh: -1 } })),
    'no Modul 3 prices',
  );
  assert.equal(
    broken((op) => ({ ...op, pb: { ...op.pb, m3_quartale_aktiv: '1,2,4' } })),
    'active quarter without windows',
  );
  assert.equal(
    broken((op) => ({ ...op, pb: { ...op.pb, m3_quartale_aktiv: '1' } })),
    'windows outside the active quarters',
  );
  assert.equal(
    broken((op) => ({ ...op, pb: { ...op.pb, zf: {} } })),
    'no Modul 3 windows',
  );
  assert.equal(
    broken((op) => ({ ...op, pb: { ...op.pb, status: 'nicht_gefunden' } })),
    'no price sheet',
  );
  // Without m3_quartale_aktiv, the quarters with windows.
  const noList = parseYear(
    yearFile(2026, { 101: (op) => ({ ...op, pb: { ...op.pb, m3_quartale_aktiv: undefined } }) }),
  ).operators[0];
  assert.equal(noList.error, undefined);
  assert.deepEqual(
    noList.quarters.map((q) => q !== null),
    [true, false, false, true],
  );
  // Names, ids and texts from the file are checked.
  const named = parseYear([
    { vnb_id: '1', name: 'A\u0007 GmbH', pb: {} },
    { vnb_id: '1x', name: 'B GmbH' },
    { vnb_id: '2', name: 'C GmbH', plz: '1234', ort: 'Ort\nX' },
    ...yearFile(2026),
  ]).operators;
  assert.ok(!named.some((op) => op.id === '1' || op.id === '1x'));
  assert.deepEqual(named[0], { id: '2', name: 'C GmbH', error: 'no price sheet' });
  // Duplicate ids: the first one wins.
  assert.equal(parseYear([...yearFile(2026), ...yearFile(2027)]).operators.length, 5);
  for (const bad of [{}, [], 'x', [{}], [{ vnb_id: '105', name: 'Ohne Blatt eG' }]]) {
    assert.throws(() => parseYear(bad), DataError);
  }
  assert.throws(() => parseYear(Array(2001).fill(yearFile(2026)[0])), DataError);
});

test('the list of years: most recent first, bounded, only plausible years', () => {
  assert.deepEqual(parseYears(['2026', '2027', 'x', 2028, '1999', '2027'], 6), [2027, 2026]);
  assert.deepEqual(
    parseYears(['2021', '2022', '2023', '2024', '2025', '2026', '2027'], 2),
    [2027, 2026],
  );
  assert.throws(() => parseYears({}, 6), DataError);
  assert.throws(() => parseYears(['x'], 6), DataError);
});

test('finding the operator of a contract: ID, exact name, the only partial name', () => {
  const { operators } = parseYear(yearFile(2026));
  assert.equal(resolveOperator(operators, '102').op.id, '102');
  assert.equal(resolveOperator(operators, 102).op.id, '102');
  assert.equal(resolveOperator(operators, ' musterstadt netz gmbh ').op.id, '101');
  assert.equal(resolveOperator(operators, 'Beispiel').op.id, '102');
  assert.equal(resolveOperator(operators, 'Musterstadt').reason, 'ambiguous');
  assert.equal(resolveOperator(operators, 'Musterstadt Land').op.id, '103');
  assert.equal(resolveOperator(operators, '999').reason, 'not_found');
  assert.equal(resolveOperator(operators, '').reason, 'not_found');
  assert.equal(resolveOperator(operators, undefined).reason, 'not_found');
  assert.equal(resolveOperator(operators, 'Beispiel\n').op.id, '102', 'trimmed');
  assert.equal(resolveOperator(operators, 'Beis\u0000piel').reason, 'not_found');
  assert.equal(resolveOperator(operators, '!!!').reason, 'not_found');
  // Two operators of the same name (after normalisation): the ID is needed.
  const twins = [...operators, { ...operators[1], id: '106', name: 'BEISPIEL Energienetze GmbH' }];
  assert.equal(resolveOperator(twins, 'Beispiel Energienetze GmbH').reason, 'ambiguous');
  assert.equal(resolveOperator(twins, '106').op.id, '106');
  assert.equal(normalize('Stadtwerke Groß-Gerau Ä'), 'stadtwerke gross gerau a');
  assert.deepEqual(
    searchOperators(operators, 'musterstadt').map((o) => o.id),
    ['101', '103'],
  );
  assert.deepEqual(
    searchOperators(operators, 'MÜNCHEN').map((o) => o.id),
    ['102'],
  );
  assert.deepEqual(
    searchOperators(operators, '10117').map((o) => o.id),
    ['103'],
  );
  assert.deepEqual(
    searchOperators(operators, '105').map((o) => o.id),
    ['105'],
  );
  assert.deepEqual(searchOperators(operators, 'Berlin', 1).length, 1);
  assert.deepEqual(searchOperators(operators, 'x'.repeat(81)), []);
  assert.deepEqual(searchOperators(operators, '\u0007'), []);
});

test('a half hour across a window boundary is priced as its two quarters', () => {
  const d = data(2026);
  // 16:00Z = 17:00 CET: 17:00-17:15 ST (8 ct), 17:15-17:30 HT (12 ct).
  const cost = price(d, contract('101', { vat_percent: 19 }), '2026-01-15T16:00:00Z');
  close(cost.cost, 0.5 * 0.08 * 1.19 + 0.5 * 0.12 * 1.19);
  close(cost.components.grid_fee, 0.1);
  close(cost.components.vat, 0.019);
  close(cost.components.supplement, 0);
  assert.equal(cost.label, 'HT');
  assert.equal(cost.starts_at, '2026-01-15T16:00:00Z');
  // The supplement is added as typed (VAT included), on the whole kWh.
  const withSupplement = price(
    d,
    contract('101', { vat_percent: 0, supplement_ct_kwh: 25 }),
    '2026-01-15T17:00:00Z',
    2,
  );
  close(withSupplement.cost, 2 * 0.12 + 2 * 0.25);
  // No energy: zero, never an error.
  close(price(d, contract('101'), '2026-01-15T17:00:00Z', 0).cost, 0);
});

test('outside the Modul 3 quarters, the standard price', () => {
  const d = data(2026);
  // 101 has Modul 3 in Q1 and Q4 only: in May, 17:30 CEST is not HT.
  const may = price(d, contract('101'), '2026-05-10T15:30:00Z', 2);
  close(may.cost, 2 * 0.08);
  assert.equal(may.label, 'Standard');
  // A sheet whose standard price differs from ST: the standard one applies.
  const other = {
    years: new Map([
      [
        2026,
        parseYear(
          yearFile(2026, {
            101: (op) => ({ ...op, pb: { ...op.pb, std_arbeitspreis_ct_kwh: 8.5 } }),
          }),
        ),
      ],
    ]),
  };
  close(price(other, contract('101'), '2026-05-10T15:30:00Z').cost, 0.085);
  close(price(other, contract('101'), '2026-01-10T12:00:00Z').cost, 0.08, 'ST in Q1');
});

test('windows per quarter: Q3 and Q4 of the same operator differ', () => {
  const d = data(2026);
  // 102: NT 23:00-06:45 in Q1-Q3, 23:00-02:30 in Q4. 01:00Z = 03:00 CEST.
  close(price(d, contract('102'), '2026-09-30T01:00:00Z').cost, 0.01, 'Q3: NT');
  close(price(d, contract('102'), '2026-10-01T01:00:00Z').cost, 0.09, 'Q4: ST');
  // The quarter is the Berlin one: 2026-09-30T22:00Z is already 1 October.
  // 101 has no Modul 3 in Q3 (standard 8 ct) and NT (2 ct) at 00:00 in Q4.
  close(price(d, contract('101'), '2026-09-30T22:00:00Z').cost, 0.02, 'Q4 00:00: NT');
  close(price(d, contract('101'), '2026-09-30T21:30:00Z').cost, 0.08, 'Q3 23:30: standard');
});

test('spring clock change: the wall-clock time decides, not the UTC hour', () => {
  const d = data(2027);
  // 102 in 2027: NT 23:00-06:45 (2 ct), ST 10 ct. 04:30Z is 05:30 CET on
  // Saturday 27 March, 06:30 CEST on Sunday 28 March (the change day).
  close(price(d, contract('102'), '2027-03-27T04:30:00Z').cost, 0.02, 'CET: NT');
  close(price(d, contract('102'), '2027-03-28T04:30:00Z').cost, 0.5 * 0.02 + 0.5 * 0.1, 'CEST');
  // 01:00Z on the change day is 03:00 CEST (02:00 never exists): NT.
  close(price(d, contract('102'), '2027-03-28T01:00:00Z').cost, 0.02);
});

test('autumn clock change: the repeated hour is priced twice by its wall-clock time', () => {
  const d = data(2026);
  // 102 in Q4 2026: NT 23:00-02:30 (1 ct), ST 9 ct. On 25 October, 00:00Z
  // is 02:00 CEST and 01:00Z is 02:00 CET again.
  const costs = intervalCosts(
    d,
    contract('102'),
    ['00:00', '00:30', '01:00', '01:30', '02:00'].map((h) => ({
      starts_at: `2026-10-25T${h}:00Z`,
      kwh: 1,
    })),
  );
  const values = costs.map((c) => Math.round(c.cost * 100) / 100);
  assert.deepEqual(values, [0.01, 0.09, 0.01, 0.09, 0.09]);
  assert.deepEqual(
    costs.map((c) => c.label),
    ['NT', 'ST', 'NT', 'ST', 'ST'],
  );
});

test('the year boundary takes the next sheet; a year without data is refused', () => {
  const both = data(2026, 2027);
  // 22:30Z = 23:30 on 31 December (2026, NT 2 ct); 23:00Z = 00:00 on 1 January 2027 (NT 3 ct).
  const costs = intervalCosts(both, contract('101'), [
    { starts_at: '2026-12-31T22:30:00Z', kwh: 1 },
    { starts_at: '2026-12-31T23:00:00Z', kwh: 1 },
  ]);
  close(costs[0].cost, 0.02);
  close(costs[1].cost, 0.03);
  assert.equal(costs[0].label, 'NT');
  assert.equal(costs[1].label, 'NT (provisional)');
  // Only 2026 held: the whole request fails, never a silent zero.
  assert.throws(
    () =>
      intervalCosts(data(2026), contract('101'), [
        { starts_at: '2026-12-31T22:30:00Z', kwh: 1 },
        { starts_at: '2026-12-31T23:00:00Z', kwh: 1 },
      ]),
    (err) => err instanceof PricingError && /2027/.test(err.message),
  );
});

test('a contract that cannot be priced is refused with the reason, never guessed', () => {
  const d = data(2026);
  const at = '2026-01-15T12:00:00Z';
  assert.throws(() => price(d, contract('999'), at), /not in the Par14a-Database data for 2026/);
  assert.throws(() => price(d, contract('Musterstadt'), at), /several operators/);
  assert.throws(() => price(d, contract('104'), at), /overlapping windows/);
  assert.throws(() => price(d, contract('105'), at), /no price sheet/);
  assert.throws(() => price(d, contract(undefined), at), PricingError);
  assert.throws(
    () => price(d, { ...contract('101'), template_key: 'other' }, at),
    /Unknown contract template/,
  );
  for (const [key, value] of [
    ['vat_percent', 'abc'],
    ['vat_percent', -1],
    ['vat_percent', 101],
    ['supplement_ct_kwh', 201],
    ['supplement_ct_kwh', Number.NaN],
    ['supplement_ct_kwh', {}],
  ]) {
    assert.throws(() => price(d, contract('101', { [key]: value }), at), PricingError, key);
  }
  for (const bad of [
    { starts_at: 'x', kwh: 1 },
    { starts_at: '2026-01-15T12:10:00Z', kwh: 1 },
    { starts_at: at, kwh: -1 },
    { starts_at: at, kwh: '1' },
    { starts_at: at, kwh: Number.POSITIVE_INFINITY },
    null,
  ]) {
    assert.throws(() => intervalCosts(d, contract('101'), [bad]), PricingError);
  }
  assert.throws(() => intervalCosts(d, contract('101'), {}), PricingError);
  assert.throws(
    () => intervalCosts(d, contract('101'), Array(2001).fill({ starts_at: at, kwh: 1 })),
    PricingError,
  );
});

test('the inputs: defaults when empty, numbers typed as text accepted', () => {
  assert.deepEqual(contractInputs({ inputs: { operator: '101' } }), {
    operator: '101',
    vat: 19,
    supplement: 0,
  });
  assert.deepEqual(
    contractInputs({ inputs: { operator: '101', vat_percent: '', supplement_ct_kwh: null } }),
    { operator: '101', vat: 19, supplement: 0 },
  );
  assert.deepEqual(
    contractInputs({ inputs: { operator: '101', vat_percent: '7', supplement_ct_kwh: '30.5' } }),
    { operator: '101', vat: 7, supplement: 30.5 },
  );
  assert.equal(contractInputs({ template_key: 'de-14a-modul-3', inputs: {} }).vat, 19);
});

test('the current price, when it changes and the next one', () => {
  const d = data(2026);
  const c = contract('101', { vat_percent: 19, supplement_ct_kwh: 20 });
  // 15:50Z = 16:50 CET: ST until 17:15 CET (16:15Z), then HT.
  const now = Date.parse('2026-01-15T15:50:00Z');
  const current = currentPrice(d, c, now);
  close(current.price, (8 * 1.19 + 20) / 100);
  assert.equal(current.valid_until, '2026-01-15T16:15:00.000Z');
  close(current.next_price, (12 * 1.19 + 20) / 100);
  assert.equal(current.label, 'ST, 2025-12-20');
  assert.equal(current.next_label, 'HT');
  // A quarter outside Modul 3: the standard price for days, the search
  // stops after 8 days without a change.
  const may = currentPrice(d, contract('101'), Date.parse('2026-05-10T10:00:00Z'));
  close(may.price, 0.08);
  assert.equal(may.valid_until, undefined);
  assert.equal(may.next_price, null);
  // The data ends with 2026: the price holds until then, no next price.
  const end = currentPrice(d, contract('101'), Date.parse('2026-12-31T22:50:00Z'));
  close(end.price, 0.02);
  assert.equal(end.valid_until, '2026-12-31T23:00:00.000Z');
  assert.equal(end.next_price, null);
  // With 2027: the provisional NT price follows.
  const next = currentPrice(data(2026, 2027), contract('101'), Date.parse('2026-12-31T22:50:00Z'));
  close(next.next_price, 0.03);
  assert.equal(next.next_label, 'NT (provisional)');
  assert.throws(() => currentPrice(d, contract('999'), now), PricingError);
  assert.ok(current.label.length <= 64);
});
