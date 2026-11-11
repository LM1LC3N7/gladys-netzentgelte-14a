// -----------------------------------------------------------------------------
// German legal time (Europe/Berlin) of an instant: the price sheets give their
// windows as wall-clock times, CET in winter, CEST in summer. Pure.
//
// On the spring change (last Sunday of March, 02:00 -> 03:00) the quarters
// 02:00-02:45 do not exist; on the autumn change (last Sunday of October,
// 03:00 -> 02:00) the wall clock shows 02:00-02:45 twice, and both are priced
// at the level of that wall-clock time.
// -----------------------------------------------------------------------------

import { TIMEZONE } from './constants.js';

export const QUARTER_HOUR = 15 * 60_000;

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `{ year, month, day, hour, minute }` of the instant `t` (epoch ms) in Berlin. */
export function berlin(t) {
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(t))) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

/** The quarter of the year (1-4) of a Berlin month (1-12). */
export const quarterOf = (month) => Math.ceil(month / 3);

/** The quarter-hour slot of the Berlin day (0-95). */
export const slotOf = ({ hour, minute }) => hour * 4 + Math.floor(minute / 15);

/** `YYYY-MM-DD HH:MM` in Berlin, for the texts shown. */
export function berlinText(t) {
  const p = berlin(t);
  const two = (n) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}
