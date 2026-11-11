// -----------------------------------------------------------------------------
// The §14a Modul 3 grid fee of an instant and the delegated costs. Pure.
//
// The core sends 30-minute intervals; the windows of the sheets are on the
// quarter-hour grid (17:15, 19:45...), so each interval is priced as its two
// quarters of kwh / 2 (consumption assumed uniform within the half hour, as
// the core engine does for its 15-minute calendars). Each quarter takes the
// level of its Berlin wall-clock time, in the sheet of its Berlin year.
//
// Price of a kWh = grid fee (ct, net) x (1 + VAT) + supplement (ct, as typed),
// in EUR. The fixed amounts are the core's (`fixed` component of the template).
// -----------------------------------------------------------------------------

import { INPUT_BOUNDS, INPUT_DEFAULTS, INPUTS, MAX_INTERVALS, TEMPLATE_KEY } from './constants.js';
import { resolveOperator } from './data.js';
import { QUARTER_HOUR, berlin, quarterOf, slotOf } from './time.js';

export const LEVEL_NAMES = { H: 'HT', S: 'ST', N: 'NT', STD: 'Standard' };
/** How far `current` looks for the next change (the longest gap is a whole quarter of ST). */
const LOOKAHEAD_SLOTS = 8 * 24 * 4;

export class PricingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PricingError';
  }
}

/** A number input: its default when empty, a PricingError when not a number within bounds. */
function numberInput(inputs, key) {
  const value = inputs?.[key];
  // Empty (or blank) is unknown: the default. A text must be a plain decimal number.
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return INPUT_DEFAULTS[key];
  }
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  const [min, max] = INPUT_BOUNDS[key];
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new PricingError(`The contract input "${key}" must be a number from ${min} to ${max}`);
  }
  return n;
}

/** The checked inputs of a contract: `{ operator, vat, supplement }`. */
export function contractInputs(contract) {
  if (contract?.template_key !== undefined && contract.template_key !== TEMPLATE_KEY) {
    throw new PricingError('Unknown contract template');
  }
  const inputs = contract?.inputs ?? {};
  // The fixed amount is the core's to compute: checked here so that the
  // bounds the documentation gives hold.
  numberInput(inputs, INPUTS.FIXED);
  return {
    operator: inputs[INPUTS.OPERATOR],
    vat: numberInput(inputs, INPUTS.VAT),
    supplement: numberInput(inputs, INPUTS.SUPPLEMENT),
  };
}

/**
 * The operator of the contract in the data of `year`: its priced sheet, or a
 * PricingError saying why not (never a guess).
 */
export function operatorOf(data, year, operator) {
  const sheet = data.years.get(year);
  if (!sheet) throw new PricingError(`No Par14a-Database data for ${year}`);
  const { op, reason } = resolveOperator(sheet.operators, operator);
  if (!op) {
    throw new PricingError(
      reason === 'ambiguous'
        ? 'The grid operator of the contract matches several operators: enter its ID'
        : `The grid operator of the contract is not in the Par14a-Database data for ${year}`,
    );
  }
  if (op.error) {
    throw new PricingError(`No usable Modul 3 tariff for this operator in ${year} (${op.error})`);
  }
  return op;
}

/** The level (`'H'`, `'S'`, `'N'`, `'STD'`) of a Berlin wall-clock time in a sheet. */
export function levelAt(op, local) {
  const levels = op.quarters[quarterOf(local.month) - 1];
  return levels ? levels[slotOf(local)] : 'STD';
}

/** The operator of a contract by Berlin year, resolved once per year (or its PricingError). */
export function operatorPicker(data, operator) {
  const memo = new Map();
  return (year) => {
    if (!memo.has(year)) {
      try {
        memo.set(year, { op: operatorOf(data, year, operator) });
      } catch (err) {
        memo.set(year, { err });
      }
    }
    const { op, err } = memo.get(year);
    if (err) throw err;
    return op;
  };
}

/** The grid fee (ct/kWh, net) and level of the quarter hour starting at `t`. */
export function gridAt(pick, t) {
  const local = berlin(t);
  const op = pick(local.year);
  const level = levelAt(op, local);
  return { level, ct: op.prices[level], op };
}

/** EUR per kWh from a net grid fee in ct/kWh. */
export const eurPerKwh = (ct, { vat, supplement }) => (ct * (1 + vat / 100) + supplement) / 100;

const labelOf = (level, op) => `${LEVEL_NAMES[level]}${op.provisional ? ' (provisional)' : ''}`;

/**
 * The costs of the intervals (`[{ starts_at, kwh }]`): one
 * `{ starts_at, cost, components, label }` each. Throws a PricingError (the
 * core then stores no cost and retries): never a silent zero.
 */
export function intervalCosts(data, contract, intervals) {
  const inputs = contractInputs(contract);
  if (!Array.isArray(intervals) || intervals.length > MAX_INTERVALS) {
    throw new PricingError('Invalid pricing request');
  }
  const pick = operatorPicker(data, inputs.operator);
  return intervals.map((interval) => {
    const t = Date.parse(interval?.starts_at);
    const kwh = interval?.kwh;
    if (!Number.isFinite(t) || t % QUARTER_HOUR !== 0) {
      throw new PricingError('Invalid interval start');
    }
    if (typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh < 0) {
      throw new PricingError('Invalid interval energy');
    }
    let grid = 0;
    const names = [];
    let provisional = false;
    for (const q of [t, t + QUARTER_HOUR]) {
      const { level, ct, op } = gridAt(pick, q);
      grid += (kwh / 2) * (ct / 100);
      if (!names.includes(LEVEL_NAMES[level])) names.push(LEVEL_NAMES[level]);
      provisional ||= Boolean(op.provisional);
    }
    // Both quarters named when they differ ("ST/HT" for 17:00-17:30 with HT from 17:15).
    const label = `${names.join('/')}${provisional ? ' (provisional)' : ''}`;
    const vat = grid * (inputs.vat / 100);
    const supplement = kwh * (inputs.supplement / 100);
    return {
      starts_at: interval.starts_at,
      cost: grid + vat + supplement,
      components: { grid_fee: grid, vat, supplement },
      label,
    };
  });
}

/**
 * The price now and when it changes:
 * `{ price, valid_until, next_price, label, next_label }` (EUR/kWh). The next
 * change is searched quarter by quarter over 8 days; past the data (a year not
 * published yet) the price holds until then with no next price.
 */
export function currentPrice(data, contract, now) {
  const inputs = contractInputs(contract);
  const start = Math.floor(now / QUARTER_HOUR) * QUARTER_HOUR;
  const pick = operatorPicker(data, inputs.operator);
  const here = gridAt(pick, start);
  const price = eurPerKwh(here.ct, inputs);
  const answer = {
    price,
    label: `${labelOf(here.level, here.op)}${here.op.read ? `, ${here.op.read}` : ''}`.slice(0, 64),
  };
  for (let k = 1; k <= LOOKAHEAD_SLOTS; k += 1) {
    const t = start + k * QUARTER_HOUR;
    let next;
    try {
      next = gridAt(pick, t);
    } catch {
      answer.valid_until = new Date(t).toISOString();
      answer.next_price = null;
      return answer;
    }
    const nextPrice = eurPerKwh(next.ct, inputs);
    if (nextPrice !== price || next.level !== here.level) {
      answer.valid_until = new Date(t).toISOString();
      answer.next_price = nextPrice;
      answer.next_label = labelOf(next.level, next.op).slice(0, 64);
      return answer;
    }
  }
  answer.next_price = null;
  return answer;
}
