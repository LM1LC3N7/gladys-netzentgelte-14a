// -----------------------------------------------------------------------------
// The integration: keeps the Par14a-Database years in memory and in /data,
// checks the source once a day (conditional request), and answers the
// delegated pricing of the core from memory only (no network on that path).
//
// Clocks: the injected timers schedule within the process (Node timers are
// monotonic); `now` (wall) dates what goes to /data, the status and the
// pricing instants, and decides the first delay after a restart from the time
// of the last attempt kept in /data, so neither a restart nor a reconnection
// checks sooner than the schedule.
//
// Each year file is checked on its own: a year the source opened without any
// sheet yet ("pending"), or a file that does not read, never stops the others,
// and its ETag is kept so that it is not downloaded again until it changes.
//
// The status is published in the background, never awaited by the pricing
// handlers (the core waits 5 s for the current price), each state once.
// -----------------------------------------------------------------------------

import {
  CHECK_EVERY,
  MAX_RETRY,
  MAX_STATE_BYTES,
  MAX_YEAR_BYTES,
  MAX_YEARS,
  MAX_YEARS_BYTES,
  PAUSE_DEFAULT,
  PAUSE_MAX,
  PAUSE_MIN,
  RETRY_STEPS,
  SAVE_TIMEOUT,
  STATUS_TIMEOUT,
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
    timers = realTimers,
    store,
    fetchImpl = (...args) => globalThis.fetch(...args),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    /** year (number) -> { operators, priced, provisional } */
    this.years = new Map();
    /** year -> { etag, lastModified } of the file held */
    this.files = {};
    /** year -> { etag, issue } of the last file refused ('pending', 'invalid', 'too_large', 'not_found') */
    this.refused = {};
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
    this.statusJob = Promise.resolve();
    this.saving = undefined;
    /** Why the last write of /data failed ('write', 'timeout'), undefined when it worked. */
    this.dataError = undefined;
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
      this.publishStatus(false, T.starting);
      await this.load(gen);
      return;
    }
    this.publishStatus();
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
      await this.statusJob;
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
        this.publishStatus(false, T.storeUnreadable);
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
      this.publishStatus();
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
    const refused = data.refused && typeof data.refused === 'object' ? data.refused : {};
    for (const [key, entry] of Object.entries(refused)) {
      if (
        /^20\d\d$/.test(key) &&
        typeof entry?.etag === 'string' &&
        ['pending', 'invalid', 'too_large', 'not_found'].includes(entry.issue)
      ) {
        this.refused[Number(key)] = { etag: entry.etag, issue: entry.issue };
      }
    }
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
          bytes: Buffer.byteLength(JSON.stringify(entry.json)),
        };
      } catch (err) {
        if (!(err instanceof DataError)) throw err;
        this.logger.warn(`Stored data for ${year} unusable: downloaded again`);
      }
    }
  }

  /**
   * The state to write: the years most recent first, as long as the file
   * stays under the size the store reads back (an older year that does not
   * fit stays in memory only, and is downloaded again after a restart).
   */
  stateToSave() {
    const years = {};
    let budget = MAX_STATE_BYTES - 64 * 1024;
    for (const year of Object.keys(this.files).sort((a, b) => b - a)) {
      const file = this.files[year];
      if (file.bytes > budget) {
        this.logger.warn(`${year} not written to /data: the state file would be too large`);
        continue;
      }
      budget -= file.bytes;
      years[year] = { etag: file.etag, lastModified: file.lastModified, json: file.json };
    }
    return { ...this.meta, lastError: this.lastError, refused: this.refused, years };
  }

  /**
   * One write at a time, bounded in time: a write that hangs counts as a
   * failed one (the data stays in memory) and the next saves are skipped
   * until it ends. Never throws.
   */
  async save() {
    if (this.saving) {
      this.dataError = 'timeout';
      return false;
    }
    let timer;
    const job = Promise.resolve().then(() => this.store.save(this.stateToSave()));
    this.saving = job.then(
      () => {},
      () => {},
    );
    this.saving.then(() => {
      this.saving = undefined;
    });
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), SAVE_TIMEOUT);
    });
    try {
      const result = await Promise.race([job.then(() => 'ok'), late]);
      this.dataError = result === 'ok' ? undefined : 'timeout';
    } catch (err) {
      this.logger.warn(`Could not write /data: ${err?.code ?? 'error'}`);
      this.dataError = 'write';
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (this.dataError === 'timeout') this.logger.warn('Writing /data takes too long: skipped');
    return this.dataError === undefined;
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
    let failure;
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
        try {
          await this.checkYear(year);
        } catch (err) {
          if (!(err instanceof SourceError)) throw err;
          // The year is left as it was; the other years are still checked,
          // except after a 429 (the pause holds for every request).
          failure = err;
          if (err.code === 'rate_limited') break;
        }
        if (gen !== this.generation) return;
      }
    } catch (err) {
      if (gen !== this.generation) return;
      if (!(err instanceof SourceError)) throw err;
      failure = err;
    }
    let delay;
    if (!failure) {
      // A year no longer listed is kept: the costs of its intervals stay priceable.
      this.meta.failures = 0;
      this.meta.pausedUntil = undefined;
      this.meta.checkedAt = this.now();
      this.lastError = undefined;
      delay = CHECK_EVERY;
    } else {
      this.meta.failures += 1;
      this.lastError = failure.code;
      this.logger.warn(`Par14a-Database check failed: ${failure.message}`);
      if (failure.code === 'rate_limited') {
        const pause = Math.min(Math.max(failure.retryAfter ?? PAUSE_DEFAULT, PAUSE_MIN), PAUSE_MAX);
        this.meta.pausedUntil = this.now() + pause;
        delay = pause;
      } else {
        delay = this.interval(this.meta.failures);
      }
    }
    await this.save();
    if (gen !== this.generation) return;
    this.schedule(gen, delay);
    this.publishStatus();
    await this.refreshContracts(gen);
  }

  /**
   * One year, conditional on the last file seen (held or refused). A file
   * without any usable sheet is "pending" (the source opened the year), one
   * that does not read is "invalid": both are remembered with their ETag and
   * never replace the data held. Throws a SourceError on a network failure.
   */
  async checkYear(year) {
    const held = this.files[year];
    const refused = this.refused[year];
    let answer;
    try {
      answer = await getJson(yearUrl(year), {
        etag: refused?.etag ?? (this.years.has(year) ? held?.etag : undefined),
        limit: MAX_YEAR_BYTES,
        fetchImpl: this.fetchImpl,
        now: this.now,
      });
    } catch (err) {
      // An answer that will not change by asking again: noted for the year, not retried sooner.
      if (err instanceof SourceError && ['too_large', 'not_found', 'invalid'].includes(err.code)) {
        this.refused[year] = { etag: refused?.etag, issue: err.code };
        this.logger.warn(`Par14a-Database ${year}: ${err.message}`);
        return;
      }
      throw err;
    }
    if (answer.status === 304) return;
    let parsed;
    try {
      parsed = parseYear(answer.json);
    } catch (err) {
      if (!(err instanceof DataError)) throw err;
      // No sheet at all in a year not held yet: the source opened it, nothing to say.
      // In a year held, it would wipe every sheet: a broken file.
      const issue =
        err.message === 'no usable price sheet' && !this.years.has(year) ? 'pending' : 'invalid';
      this.refused[year] = { etag: answer.etag, issue };
      this.logger.warn(`Par14a-Database ${year}: file refused (${err.message})`);
      return;
    }
    delete this.refused[year];
    this.years.set(year, parsed);
    this.files[year] = {
      etag: answer.etag,
      lastModified: answer.lastModified,
      json: answer.json,
      bytes: Buffer.byteLength(JSON.stringify(answer.json)),
    };
    this.logger.info(
      `Par14a-Database ${year}: ${parsed.priced} operators priced, ${parsed.provisional} provisional`,
    );
  }

  // --- Status ---------------------------------------------------------------------

  /**
   * Publishes the status in the background (one at a time, in order, each
   * bounded in time); a state already published is not sent again, even
   * after a failure (the next change or reconnection sends it). Returns the
   * promise of the publication, which never rejects: callers need not wait.
   */
  publishStatus(connected, message) {
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
          issues: Object.entries(this.refused)
            .map(([year, r]) => ({
              year: Number(year),
              issue: r.issue,
              held: this.years.has(Number(year)),
            }))
            .sort((x, y) => y.year - x.year),
          dataError: this.dataError,
        }),
      };
    }
    const key = JSON.stringify(state);
    if (key === this.lastStatus) return this.statusJob;
    this.lastStatus = key;
    this.statusJob = this.statusJob.then(() => this.sendStatus(state));
    return this.statusJob;
  }

  async sendStatus(state) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve('timeout'), STATUS_TIMEOUT);
    });
    try {
      const sent = Promise.resolve().then(() =>
        this.gladys.setConnectionStatus(state.connected, state.message),
      );
      if ((await Promise.race([sent.then(() => 'ok'), late])) === 'timeout') {
        sent.catch(() => {});
        this.logger.warn('Status not published in time');
      }
    } catch (err) {
      this.logger.warn(`Status not published: ${err?.message ?? err}`);
    } finally {
      this.timers.clearTimeout(timer);
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
    this.publishStatus();
  }

  // --- Delegated pricing ----------------------------------------------------------

  async energyPrice({ contract, intervals } = {}) {
    if (!Array.isArray(intervals) || intervals.length === 0) return [];
    this.noteContract(contract);
    // The status follows in the background: the answer never waits for it.
    this.publishStatus();
    return intervalCosts({ years: this.years }, contract, intervals);
  }

  async energyCurrent({ contract } = {}) {
    this.noteContract(contract);
    this.publishStatus();
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
