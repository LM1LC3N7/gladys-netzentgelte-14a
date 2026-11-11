// -----------------------------------------------------------------------------
// The Par14a-Database year file (daten/<year>.json of its web page, CC BY 4.0)
// read into a compact, checked form. Pure; nothing here trusts the file:
//
// - an operator is `{ vnb_id, name, plz?, ort?, pb? }`, `pb` its price sheet of
//   the year: `status` (`endgueltig` final, `vorlaeufig` provisional), the
//   Modul 3 prices `m3_ht_ct_kwh` / `m3_st_ct_kwh` / `m3_nt_ct_kwh` (ct/kWh,
//   net), the standard price `std_arbeitspreis_ct_kwh`, the quarters where
//   Modul 3 applies `m3_quartale_aktiv` ("1,4") and the windows `zf`
//   (`{ "1": { ht: ["17:00-20:00"], nt: ["00:00-06:00"] } }`; the rest of the
//   day is ST);
// - a window is `HH:MM-HH:MM` on the quarter-hour grid, start included, end
//   excluded, `24:00` as an end; an end before the start crosses midnight;
// - a quarter without windows is outside Modul 3: the standard price applies.
//
// An operator whose sheet is unusable (a price missing or out of bounds, a
// malformed or overlapping window) is kept for the search with the reason, and
// is never priced. A file that is not a list of operators is refused whole.
// -----------------------------------------------------------------------------

import { MAX_OPERATORS, MAX_PRICE_CT, MAX_TEXT, MAX_WINDOWS } from './constants.js';

export const LEVELS = { HT: 'H', ST: 'S', NT: 'N' };
const SLOTS = 96;
const WINDOW = /^([01]\d|2[0-3]):(00|15|30|45)-(?:([01]\d|2[0-3]):(00|15|30|45)|(24):(00))$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const WEEKDAYS_NOTE = /werktag|mo\.?\s*(?:bis|-|–)\s*fr/i;

export class DataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataError';
  }
}

/** A short text from the file, or undefined (wrong type, control characters, too long). */
function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (!t || t.length > max || CONTROL.test(t)) return undefined;
  return t;
}

/** A price in ct/kWh: a finite number within [0, MAX_PRICE_CT], else undefined. */
function price(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PRICE_CT
    ? value
    : undefined;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (value) => (typeof value === 'string' && DATE.test(value) ? value : undefined);

/** `"17:15-20:00"` -> the slots it covers, or a DataError. */
export function windowSlots(window) {
  const m = typeof window === 'string' ? WINDOW.exec(window) : null;
  if (!m) throw new DataError('malformed window');
  const start = Number(m[1]) * 4 + Number(m[2]) / 15;
  const end = m[5] ? SLOTS : Number(m[3]) * 4 + Number(m[4]) / 15;
  if (start === end) throw new DataError('empty window');
  // An end before the start crosses midnight: to 24:00, then from 00:00.
  const length = end > start ? end - start : end + SLOTS - start;
  const slots = [];
  for (let i = 0; i < length; i += 1) slots.push((start + i) % SLOTS);
  return slots;
}

/** The 96 levels of a quarter (`'H'`, `'S'`, `'N'`), from its HT and NT windows. */
export function quarterLevels(windows) {
  if (!windows || typeof windows !== 'object' || Array.isArray(windows)) {
    throw new DataError('malformed quarter');
  }
  const levels = Array(SLOTS).fill(LEVELS.ST);
  for (const [key, level] of [
    ['ht', LEVELS.HT],
    ['nt', LEVELS.NT],
  ]) {
    const list = windows[key] ?? [];
    if (!Array.isArray(list) || list.length > MAX_WINDOWS) throw new DataError('malformed quarter');
    for (const window of list) {
      for (const s of windowSlots(window)) {
        // Two windows on the same quarter hour: the sheet was misread.
        if (levels[s] !== LEVELS.ST) throw new DataError('overlapping windows');
        levels[s] = level;
      }
    }
  }
  return levels.join('');
}

/** `"1,4"` -> [1, 4], or undefined when absent or malformed. */
function quarters(value) {
  if (typeof value !== 'string' || !/^[1-4](,[1-4]){0,3}$/.test(value)) return undefined;
  return [...new Set(value.split(',').map(Number))].sort();
}

/**
 * The Modul 3 tariff of a sheet: `{ prices, quarters }` with `quarters[q-1]`
 * the 96 levels of quarter q, or null outside Modul 3. Throws a DataError.
 */
function modul3(pb) {
  const prices = {
    H: price(pb.m3_ht_ct_kwh),
    S: price(pb.m3_st_ct_kwh),
    N: price(pb.m3_nt_ct_kwh),
  };
  if (prices.H === undefined || prices.S === undefined || prices.N === undefined) {
    throw new DataError('no Modul 3 prices');
  }
  // The standard price applies outside the Modul 3 quarters; ST when absent
  // (the regulation sets ST to the standard price, the data shows it equal).
  prices.STD = price(pb.std_arbeitspreis_ct_kwh) ?? prices.S;
  const zf = pb.zf;
  if (!zf || typeof zf !== 'object' || Array.isArray(zf) || Object.keys(zf).length === 0) {
    throw new DataError('no Modul 3 windows');
  }
  const active = quarters(pb.m3_quartale_aktiv) ?? Object.keys(zf).map(Number).sort();
  const levels = [null, null, null, null];
  for (const q of active) {
    if (!(q >= 1 && q <= 4)) throw new DataError('malformed quarters');
    const windows = zf[String(q)];
    if (!windows) throw new DataError('active quarter without windows');
    levels[q - 1] = quarterLevels(windows);
  }
  for (const key of Object.keys(zf)) {
    if (!active.includes(Number(key))) throw new DataError('windows outside the active quarters');
  }
  return { prices, quarters: levels };
}

/** One operator of the file, compact, or undefined when it cannot be named. */
export function parseOperator(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const id =
    typeof entry.vnb_id === 'string' && /^\d{1,10}$/.test(entry.vnb_id) ? entry.vnb_id : undefined;
  const name = text(entry.name);
  if (!id || !name) return undefined;
  const op = { id, name };
  const plz = typeof entry.plz === 'string' && /^\d{5}$/.test(entry.plz) ? entry.plz : undefined;
  const ort = text(entry.ort, 80);
  if (plz) op.plz = plz;
  if (ort) op.ort = ort;
  const pb = entry.pb;
  if (!pb || typeof pb !== 'object' || Array.isArray(pb)) {
    op.error = 'no price sheet';
    return op;
  }
  if (pb.status !== 'endgueltig' && pb.status !== 'vorlaeufig') {
    op.error = 'no price sheet';
    return op;
  }
  op.provisional = pb.status === 'vorlaeufig';
  const read = date(pb.abgerufen_am);
  const from = date(pb.gueltig_ab);
  if (read) op.read = read;
  if (from) op.from = from;
  if (typeof pb.hinweise === 'string' && WEEKDAYS_NOTE.test(pb.hinweise)) op.weekdaysNote = true;
  try {
    Object.assign(op, modul3(pb));
  } catch (err) {
    if (!(err instanceof DataError)) throw err;
    op.error = err.message;
  }
  return op;
}

/**
 * The year file (parsed JSON) -> `{ operators: [...], priced, provisional }`.
 * Throws a DataError when it is not a list of operators or none is usable.
 */
export function parseYear(json) {
  if (!Array.isArray(json) || json.length === 0 || json.length > MAX_OPERATORS) {
    throw new DataError('not a Par14a-Database year file');
  }
  const operators = [];
  const seen = new Set();
  for (const entry of json) {
    const op = parseOperator(entry);
    if (!op || seen.has(op.id)) continue;
    seen.add(op.id);
    operators.push(op);
  }
  const priced = operators.filter((op) => !op.error).length;
  if (priced === 0) throw new DataError('no usable price sheet');
  const provisional = operators.filter((op) => !op.error && op.provisional).length;
  return { operators, priced, provisional };
}

/** `jahre.json` (`["2027", "2026"]`) -> the years, most recent first, at most `max`. */
export function parseYears(json, max) {
  if (!Array.isArray(json)) throw new DataError('not a list of years');
  const years = [
    ...new Set(json.filter((y) => typeof y === 'string' && /^20\d\d$/.test(y)).map(Number)),
  ].sort((a, b) => b - a);
  if (years.length === 0) throw new DataError('no year');
  return years.slice(0, max);
}

// --- Finding an operator --------------------------------------------------------

/** Lowercase, without accents, ß as ss, anything but letters and digits as one space. */
export function normalize(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The operator a contract names: its vnbdigital ID, or its name (exact, else
 * the only name containing it). `{ op }` or `{ reason: 'not_found' | 'ambiguous' }`.
 */
export function resolveOperator(operators, input) {
  const raw = typeof input === 'string' || typeof input === 'number' ? String(input).trim() : '';
  if (!raw || raw.length > MAX_TEXT || CONTROL.test(raw)) return { reason: 'not_found' };
  if (/^\d{1,10}$/.test(raw)) {
    const op = operators.find((o) => o.id === raw);
    return op ? { op } : { reason: 'not_found' };
  }
  const wanted = normalize(raw);
  if (!wanted) return { reason: 'not_found' };
  const exact = operators.filter((o) => normalize(o.name) === wanted);
  if (exact.length === 1) return { op: exact[0] };
  if (exact.length > 1) return { reason: 'ambiguous' };
  const partial = operators.filter((o) => normalize(o.name).includes(wanted));
  if (partial.length === 1) return { op: partial[0] };
  return { reason: partial.length > 1 ? 'ambiguous' : 'not_found' };
}

/** The operators matching a search (ID, name, town or postcode), at most `limit`. */
export function searchOperators(operators, query, limit = 10) {
  const raw = typeof query === 'string' ? query.trim() : '';
  if (!raw || raw.length > 80 || CONTROL.test(raw)) return [];
  if (/^\d{1,10}$/.test(raw) && raw.length !== 5) {
    return operators.filter((o) => o.id === raw).slice(0, limit);
  }
  const wanted = normalize(raw);
  if (!wanted) return [];
  return operators
    .filter(
      (o) =>
        o.id === raw ||
        o.plz === raw ||
        normalize(o.name).includes(wanted) ||
        (o.ort && normalize(o.ort).includes(wanted)),
    )
    .slice(0, limit);
}
