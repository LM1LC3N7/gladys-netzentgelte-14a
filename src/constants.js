// -----------------------------------------------------------------------------
// Keys shared with the manifest, the data source and the bounds. The manifest
// keys (template, inputs, actions, config) are forever: contracts and users
// store them.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;
export const USER_AGENT = `gladys-netzentgelte-14a/${VERSION} (+https://github.com/LM1LC3N7/gladys-netzentgelte-14a)`;

/** The published JSON of the Par14a-Database web page (CC BY 4.0), one file per year. */
export const DATA_BASE_URL = 'https://the78mole.github.io/Par14a-Database/daten';
export const YEARS_URL = `${DATA_BASE_URL}/jahre.json`;
export const yearUrl = (year) => `${DATA_BASE_URL}/${year}.json`;

export const ATTRIBUTION = 'Par14a-Database (the78mole), CC BY 4.0';

/** German legal time: the windows of the price sheets are wall-clock times there. */
export const TIMEZONE = 'Europe/Berlin';

export const TEMPLATE_KEY = 'de-14a-modul-3';
export const INPUTS = {
  OPERATOR: 'operator',
  VAT: 'vat_percent',
  SUPPLEMENT: 'supplement_ct_kwh',
  FIXED: 'fixed_eur_month',
};
export const INPUT_DEFAULTS = { [INPUTS.VAT]: 19, [INPUTS.SUPPLEMENT]: 0, [INPUTS.FIXED]: 0 };
export const INPUT_BOUNDS = {
  [INPUTS.VAT]: [0, 100],
  [INPUTS.SUPPLEMENT]: [0, 200],
  [INPUTS.FIXED]: [0, 1000],
};

export const ACTIONS = { FIND: 'find_operator' };

// --- Bounds ------------------------------------------------------------------

export const HTTP_TIMEOUT = 30_000;
/** A year file is about 1 MB (2026: 950 KB); more is not the published data. */
export const MAX_YEAR_BYTES = 8 * 1024 * 1024;
export const MAX_YEARS_BYTES = 4 * 1024;
/** Operators kept per year (about 750 in Germany). */
export const MAX_OPERATORS = 2000;
/** Years kept: the most recent ones listed by jahre.json. */
export const MAX_YEARS = 6;
/** The /data state file read back at most this size (larger: not ours). */
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
/** A price (ct/kWh, net) above this is not a grid fee: the operator is refused. */
export const MAX_PRICE_CT = 200;
/** Windows per level and quarter. */
export const MAX_WINDOWS = 12;
export const MAX_TEXT = 200;
/** Intervals in one pricing request (the core sends 1,488 at most). */
export const MAX_INTERVALS = 2000;

// --- Schedule ----------------------------------------------------------------

/** The source changes a few times a week: one check a day, conditional (ETag). */
export const CHECK_EVERY = 24 * 60 * 60_000;
/** After a failed check: 5, 15, 30, 60 minutes, then every 6 hours at most. */
export const RETRY_STEPS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
export const MAX_RETRY = 6 * 60 * 60_000;
/** A 429: its Retry-After within these bounds (10 minutes when absent). */
export const PAUSE_MIN = 60_000;
export const PAUSE_MAX = 6 * 60 * 60_000;
export const PAUSE_DEFAULT = 10 * 60_000;
/** /data unreadable (not missing): read again on this period. */
export const STORE_RETRY = 10_000;
/** A write of /data longer than this counts as failed (the data stays in memory). */
export const SAVE_TIMEOUT = 10_000;
/** A year left out of /data for its size: downloaded again at a start, at most once an hour. */
export const REFILL_EVERY = 60 * 60_000;
/** A status publication longer than this is given up (the next one goes on). */
export const STATUS_TIMEOUT = 10_000;
