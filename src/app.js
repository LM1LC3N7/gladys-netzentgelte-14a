// -----------------------------------------------------------------------------
// The integration: keeps the Par14a-Database years in memory and in /data,
// checks the source once a day (conditional request), and answers the
// delegated pricing of the core from memory only (no network on that path).
//
// Clocks: `monotonic` schedules within the process; `now` (wall) dates what
// goes to /data, the status and the pricing instants. A restart reads the
// time of the last attempt from /data, so neither a restart nor a
// reconnection checks sooner than the schedule.
// -----------------------------------------------------------------------------

import {
  CHECK_EVERY,
  MAX_RETRY,
  MAX_YEAR_BYTES,
  MAX_YEARS,
  MAX_YEARS_BYTES,
  PAUSE_DEFAULT,
  PAUSE_MAX,
  PAUSE_MIN,
  RETRY_STEPS,
  STORE_RETRY,
  TEMPLATE_KEY,
  YEARS_URL,
  yearUrl,
} from './constants.js';
import { DataError, parseYear, parseYears, searchOperators } from './data.js';
import { SourceError, getJson } from './http.js';
import { T, searchResult } from './i18n.js';
import { PricingError, contractInputs, currentPrice, intervalCosts, operatorOf } from './tariff.js';
import { berlin } from './time.js';

const realTimers = { setTimeout, clearTimeout };

/** A wall date read from /data: a finite number not in the future, else undefined. */
const pastDate = (value, now) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now
    ? value
    : undefined;

export class App {
  constructor({
    gladys,
    logger = console,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = realTimers,
    store,
    fetchImpl = (...args) => globalThis.fetch(...args),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    /** year (number) -> { operators, priced, provisional } */
    this.years = new Map();
    /** year -> { etag, lastModified } of the file held */
    this.files = {};
    this.meta = { attemptAt: undefined, checkedAt: undefined, failures: 0, pausedUntil: undefined };
    this.lastError = undefined;
    this.retryAt = undefined;
    this.loaded = false;
    this.loading = undefined;
    this.timer = undefined;
    this.storeTimer = undefined;
    this.checking = undefined;
    this.running = false;
    this.generation = 0;
    /** contract id -> { unresolved, weekdays } */
    this.contracts = new Map();
    this.lastStatus = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Connected to Gladys (first time or again): load /data once, schedule, republish the status. */
  async start() {
    this.running = true;
    this.generation += 1;
    const gen = this.generation;
    this.lastStatus = undefined;
    // A load of the previous connection may still run: wait for it.
    await this.loading?.catch(() => {});
    if (gen !== this.generation) return;
    if (!this.loaded) {
      await this.publishStatus(false, T.starting);
      await this.load(gen);
      return;
    }
    await this.publishStatus();
    // A check of the previous connection may still run: the schedule resumes after it.
    const resume = () => {
      if (gen === this.generation && this.running && !this.timer && !this.checking) {
        this.schedule(gen);
      }
    };
    if (this.checking) this.checking.then(resume, resume);
    else resume();
    await this.refreshContracts(gen);
  }

  async stop() {
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    await this.checking?.catch(() => {});
  }

  clearTimers() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    if (this.storeTimer) this.timers.clearTimeout(this.storeTimer);
    this.timer = undefined;
    this.storeTimer = undefined;
  }

  /** Every pending piece of work (tests). */
  async idle() {
    for (let i = 0; i < 10; i += 1) {
      await this.loading;
      await this.checking;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // --- /data ----------------------------------------------------------------------

  /** Reads /data once; unreadable: read again every 10 s, nothing downloaded meanwhile. */
  async load(gen) {
    if (this.storeTimer) this.timers.clearTimeout(this.storeTimer);
    this.storeTimer = undefined;
    this.loading = (async () => {
      const result = await this.store.load();
      if (gen !== this.generation || !this.running) return;
      if (result.status === 'unreadable') {
        this.logger.warn('/data unreadable: read again in 10 s');
        await this.publishStatus(false, T.storeUnreadable);
        this.storeTimer = this.timers.setTimeout(() => {
          this.storeTimer = undefined;
          if (gen === this.generation && this.running && !this.loading) {
            this.load(gen).catch((err) => this.logger.error('Load failed', err));
          }
        }, STORE_RETRY);
        return;
      }
      if (result.status === 'ok') this.restore(result.data);
      this.loaded = true;
      this.schedule(gen);
      await this.publishStatus();
      await this.refreshContracts(gen);
    })().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /** The state of /data, each part checked; a part that does not read is dropped. */
  restore(data) {
    const now = this.now();
    this.meta.attemptAt = pastDate(data.attemptAt, now);
    this.meta.checkedAt = pastDate(data.checkedAt, now);
    this.meta.failures =
      Number.isInteger(data.failures) && data.failures >= 0 && data.failures < 1000
        ? data.failures
        : 0;
    // A pause longer than its maximum is not ours: ignored.
    this.meta.pausedUntil =
      typeof data.pausedUntil === 'number' &&
      data.pausedUntil > now &&
      data.pausedUntil <= now + PAUSE_MAX
        ? data.pausedUntil
        : undefined;
    this.lastError = typeof data.lastError === 'string' ? data.lastError : undefined;
    const years = data.years && typeof data.years === 'object' ? data.years : {};
    for (const [key, entry] of Object.entries(years)) {
      const year = Number(key);
      if (!/^20\d\d$/.test(key) || !entry || typeof entry !== 'object') continue;
      try {
        // The stored file is the source file as received: checked again here.
        const parsed = parseYear(entry.json);
        this.years.set(year, parsed);
        this.files[year] = {
          etag: typeof entry.etag === 'string' ? entry.etag : undefined,
          lastModified: typeof entry.lastModified === 'string' ? entry.lastModified : undefined,
          json: entry.json,
        };
      } catch (err) {
        if (!(err instanceof DataError)) throw err;
        this.logger.warn(`Stored data for ${year} unusable: downloaded again`);
      }
    }
  }

  async save() {
    const years = {};
    for (const [year, file] of Object.entries(this.files)) {
      years[year] = { etag: file.etag, lastModified: file.lastModified, json: file.json };
    }
    try {
      await this.store.save({ ...this.meta, lastError: this.lastError, years });
      return true;
    } catch (err) {
      this.logger.warn(`Could not write /data: ${err?.code ?? 'error'}`);
      return false;
    }
  }

  // --- Schedule -------------------------------------------------------------------

  /** The delay before the next check, decided on one reading of the wall clock. */
  nextDelay(now) {
    const { attemptAt, failures, pausedUntil } = this.meta;
    let due = attemptAt === undefined ? now : attemptAt + this.interval(failures);
    if (pausedUntil !== undefined && pausedUntil > due) due = pausedUntil;
    return Math.min(Math.max(0, due - now), CHECK_EVERY);
  }

  interval(failures) {
    if (failures <= 0) return CHECK_EVERY;
    return Math.min(RETRY_STEPS[Math.min(failures, RETRY_STEPS.length) - 1], MAX_RETRY);
  }

  schedule(gen, delay) {
    if (gen !== this.generation || !this.running) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    const now = this.now();
    const wait = delay ?? this.nextDelay(now);
    this.retryAt = now + wait;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.check(gen).catch((err) => this.logger.error('Check failed', err));
    }, wait);
  }

  // --- Checking the source --------------------------------------------------------

  /** One check: the list of years, then each year file (conditional). One at a time. */
  async check(gen) {
    if (this.checking || gen !== this.generation || !this.running) return this.checking;
    this.checking = this.runCheck(gen).finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  async runCheck(gen) {
    // The attempt is dated in /data before the first request: a restart in
    // the middle never asks again sooner.
    this.meta.attemptAt = this.now();
    await this.save();
    if (gen !== this.generation) return;
    let delay;
    try {
      const list = await getJson(YEARS_URL, {
        limit: MAX_YEARS_BYTES,
        fetchImpl: this.fetchImpl,
        now: this.now,
      });
      if (list.status !== 200) throw new SourceError('invalid', 'unexpected 304');
      let years;
      try {
        years = parseYears(list.json, MAX_YEARS);
      } catch (err) {
        throw new SourceError('invalid', err.message);
      }
      if (gen !== this.generation) return;
      for (const year of years) {
        await this.checkYear(year);
        if (gen !== this.generation) return;
      }
      // A year no longer listed is kept: the costs of its intervals stay priceable.
      this.meta.failures = 0;
      this.meta.pausedUntil = undefined;
      this.meta.checkedAt = this.now();
      this.lastError = undefined;
      delay = CHECK_EVERY;
    } catch (err) {
      if (gen !== this.generation) return;
      if (!(err instanceof SourceError)) throw err;
      this.meta.failures += 1;
      this.lastError = err.code;
      this.logger.warn(`Par14a-Database check failed: ${err.message}`);
      if (err.code === 'rate_limited') {
        const pause = Math.min(Math.max(err.retryAfter ?? PAUSE_DEFAULT, PAUSE_MIN), PAUSE_MAX);
        this.meta.pausedUntil = this.now() + pause;
        delay = pause;
      } else {
        delay = this.interval(this.meta.failures);
      }
    }
    await this.save();
    if (gen !== this.generation) return;
    this.schedule(gen, delay);
    await this.publishStatus();
    await this.refreshContracts(gen);
  }

  async checkYear(year) {
    const held = this.files[year];
    const answer = await getJson(yearUrl(year), {
      etag: this.years.has(year) ? held?.etag : undefined,
      limit: MAX_YEAR_BYTES,
      fetchImpl: this.fetchImpl,
      now: this.now,
    });
    if (answer.status === 304) return;
    let parsed;
    try {
      parsed = parseYear(answer.json);
    } catch (err) {
      // The data held stays in use; the new file is refused whole.
      throw new SourceError('invalid', `${year}: ${err.message}`);
    }
    this.years.set(year, parsed);
    this.files[year] = { etag: answer.etag, lastModified: answer.lastModified, json: answer.json };
    this.logger.info(
      `Par14a-Database ${year}: ${parsed.priced} operators priced, ${parsed.provisional} provisional`,
    );
  }

  // --- Status ---------------------------------------------------------------------

  async publishStatus(connected, message) {
    let state = { connected, message };
    if (message === undefined) {
      const years = [...this.years.entries()]
        .sort(([a], [b]) => b - a)
        .map(([year, y]) => ({ year, priced: y.priced, provisional: y.provisional }));
      const published = Object.values(this.files)
        .map((f) => Date.parse(f.lastModified))
        .filter(Number.isFinite)
        .sort((a, b) => b - a)[0];
      let unresolved = 0;
      let weekdays = 0;
      for (const c of this.contracts.values()) {
        if (c.unresolved) unresolved += 1;
        if (c.weekdays) weekdays += 1;
      }
      state = {
        connected: years.length > 0,
        message: T.status({
          years,
          published: published ? new Date(published).toISOString().slice(0, 10) : undefined,
          checkedAt: this.meta.checkedAt,
          error: this.lastError,
          retryAt: this.retryAt,
          unresolved,
          weekdays,
        }),
      };
    }
    const key = JSON.stringify(state);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    try {
      await this.gladys.setConnectionStatus(state.connected, state.message);
    } catch (err) {
      this.lastStatus = undefined;
      this.logger.warn(`Status not published: ${err?.message ?? err}`);
    }
  }

  /** The year whose sheet describes a contract today: the current one, else the latest held. */
  statusYear() {
    const year = berlin(this.now()).year;
    if (this.years.has(year)) return year;
    return [...this.years.keys()].sort((a, b) => b - a)[0];
  }

  /** Remembers whether a contract's operator resolves (status only). */
  noteContract(contract) {
    if (!contract || (typeof contract.id !== 'string' && typeof contract.id !== 'number')) return;
    if (contract.template_key !== undefined && contract.template_key !== TEMPLATE_KEY) return;
    const year = this.statusYear();
    if (year === undefined) return;
    let note;
    try {
      const op = operatorOf({ years: this.years }, year, contractInputs(contract).operator);
      note = { unresolved: false, weekdays: Boolean(op.weekdaysNote) };
    } catch (err) {
      if (!(err instanceof PricingError)) throw err;
      note = { unresolved: true, weekdays: false };
    }
    this.contracts.set(String(contract.id), note);
  }

  /** The contracts referencing the template, read from Gladys (secondary: a failure changes nothing). */
  async refreshContracts(gen) {
    let list;
    try {
      list = await this.gladys.getEnergyContracts();
    } catch (err) {
      this.logger.warn(`Contracts not read: ${err?.message ?? err}`);
      return;
    }
    if (gen !== this.generation || !Array.isArray(list)) return;
    this.contracts.clear();
    for (const contract of list.slice(0, 100)) this.noteContract(contract);
    await this.publishStatus();
  }

  // --- Delegated pricing ----------------------------------------------------------

  async energyPrice({ contract, intervals } = {}) {
    if (!Array.isArray(intervals) || intervals.length === 0) return [];
    this.noteContract(contract);
    try {
      return intervalCosts({ years: this.years }, contract, intervals);
    } finally {
      await this.publishStatus();
    }
  }

  async energyCurrent({ contract } = {}) {
    this.noteContract(contract);
    await this.publishStatus();
    try {
      return currentPrice({ years: this.years }, contract, this.now());
    } catch (err) {
      if (!(err instanceof PricingError)) throw err;
      return { price: null };
    }
  }

  // --- The search button ----------------------------------------------------------

  async findOperator(fields = {}) {
    const year = this.statusYear();
    if (year === undefined) return T.noData;
    const query = typeof fields.query === 'string' ? fields.query : '';
    if (!query.trim()) return T.emptySearch;
    const matches = searchOperators(this.years.get(year).operators, query, 11);
    if (matches.length === 0) return T.noMatch;
    return searchResult(matches.slice(0, 10), year, matches.length > 10);
  }
}
