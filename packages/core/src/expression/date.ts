/**
 * A small, dependency-free date/time wrapper with a Luxon-like surface.
 * It intentionally implements only the operations that workflow expressions
 * need, using Intl for timezone conversion.
 */

const OFFSET_CACHE = new Map<string, Intl.DateTimeFormat>();
const PARTS_CACHE = new Map<string, Intl.DateTimeFormat>();
const MONTH_LONG_CACHE = new Map<string, Intl.DateTimeFormat>();
const MONTH_SHORT_CACHE = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_LONG_CACHE = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_SHORT_CACHE = new Map<string, Intl.DateTimeFormat>();

export interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: number;
}

export interface DurationLike {
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
}

export type DateUnit =
  | 'years'
  | 'months'
  | 'weeks'
  | 'days'
  | 'hours'
  | 'minutes'
  | 'seconds'
  | 'milliseconds';

export type BeginningUnit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

export class DraflowDateTime {
  readonly #millis: number;
  readonly timeZone: string;

  constructor(millis: number, timeZone = 'UTC') {
    this.#millis = millis;
    this.timeZone = timeZone;
  }

  static now(timeZone = 'UTC'): DraflowDateTime {
    return new DraflowDateTime(Date.now(), timeZone);
  }

  static fromMillis(millis: number, timeZone = 'UTC'): DraflowDateTime {
    return new DraflowDateTime(millis, timeZone);
  }

  static fromISO(value: string, timeZone = 'UTC'): DraflowDateTime {
    const millis = Date.parse(value);
    if (!Number.isFinite(millis)) {
      throw new Error(`Invalid ISO date "${value}"`);
    }
    return new DraflowDateTime(millis, timeZone);
  }

  toMillis(): number {
    return this.#millis;
  }

  toISO(): string {
    const parts = getParts(this.#millis, this.timeZone);
    const offset = getOffsetMinutes(this.#millis, this.timeZone);
    const base = `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}T${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}.${pad(parts.millisecond, 3)}`;
    if (offset === 0) return `${base}Z`;
    return `${base}${formatOffset(offset, ':')}`;
  }

  toJSON(): string {
    return this.toISO();
  }

  toString(): string {
    return this.toISO();
  }

  format(format: string): string {
    const parts = getParts(this.#millis, this.timeZone);
    const offset = getOffsetMinutes(this.#millis, this.timeZone);
    const tokens: Array<[string, () => string]> = [
      ['yyyy', () => pad(parts.year, 4)],
      ['yy', () => pad(parts.year % 100, 2)],
      ['MMMM', () => monthName(this.#millis, this.timeZone, true)],
      ['MMM', () => monthName(this.#millis, this.timeZone, false)],
      ['MM', () => pad(parts.month, 2)],
      ['M', () => String(parts.month)],
      ['dd', () => pad(parts.day, 2)],
      ['d', () => String(parts.day)],
      ['EEEE', () => weekdayName(this.#millis, this.timeZone, true)],
      ['EEE', () => weekdayName(this.#millis, this.timeZone, false)],
      ['HH', () => pad(parts.hour, 2)],
      ['H', () => String(parts.hour)],
      ['hh', () => pad(parts.hour % 12 === 0 ? 12 : parts.hour % 12, 2)],
      ['h', () => String(parts.hour % 12 === 0 ? 12 : parts.hour % 12)],
      ['mm', () => pad(parts.minute, 2)],
      ['m', () => String(parts.minute)],
      ['ss', () => pad(parts.second, 2)],
      ['s', () => String(parts.second)],
      ['SSS', () => pad(parts.millisecond, 3)],
      ['ZZZ', () => formatOffset(offset, ':')],
      ['ZZ', () => formatOffset(offset, '')],
      ['Z', () => formatOffset(offset, ':')],
      ['a', () => (parts.hour < 12 ? 'AM' : 'PM')],
    ];
    tokens.sort((a, b) => b[0].length - a[0].length);

    let output = '';
    let index = 0;
    while (index < format.length) {
      const char = format[index];
      if (char === undefined) break;

      if (char === "'") {
        const end = format.indexOf("'", index + 1);
        if (end === -1) {
          output += format.slice(index + 1);
          break;
        }
        output += format.slice(index + 1, end);
        index = end + 1;
        continue;
      }

      let matched = false;
      for (const [token, render] of tokens) {
        if (format.startsWith(token, index)) {
          output += render();
          index += token.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        output += char;
        index += 1;
      }
    }
    return output;
  }

  toFormat(format: string): string {
    return this.format(format);
  }

  plus(duration: DurationLike): DraflowDateTime {
    return new DraflowDateTime(addDuration(this.#millis, this.timeZone, duration, 1), this.timeZone);
  }

  minus(duration: DurationLike): DraflowDateTime {
    return new DraflowDateTime(addDuration(this.#millis, this.timeZone, duration, -1), this.timeZone);
  }

  diffTo(other: DraflowDateTime, unit: DateUnit = 'milliseconds'): number {
    return diff(this.#millis, other.#millis, unit);
  }

  diffToNow(unit: DateUnit = 'milliseconds'): number {
    return diff(this.#millis, Date.now(), unit);
  }

  beginningOf(unit: BeginningUnit): DraflowDateTime {
    const parts = getParts(this.#millis, this.timeZone);
    if (unit === 'year') {
      parts.month = 1;
      parts.day = 1;
      parts.hour = 0;
      parts.minute = 0;
      parts.second = 0;
      parts.millisecond = 0;
    } else if (unit === 'month') {
      parts.day = 1;
      parts.hour = 0;
      parts.minute = 0;
      parts.second = 0;
      parts.millisecond = 0;
    } else if (unit === 'week') {
      const daysSinceMonday = (parts.weekday + 6) % 7;
      const shifted = new Date(this.#millis - daysSinceMonday * 86_400_000);
      const shiftedParts = getParts(shifted.getTime(), this.timeZone);
      shiftedParts.hour = 0;
      shiftedParts.minute = 0;
      shiftedParts.second = 0;
      shiftedParts.millisecond = 0;
      return new DraflowDateTime(zonedTimeToUtc(shiftedParts, this.timeZone), this.timeZone);
    } else if (unit === 'day') {
      parts.hour = 0;
      parts.minute = 0;
      parts.second = 0;
      parts.millisecond = 0;
    } else if (unit === 'hour') {
      parts.minute = 0;
      parts.second = 0;
      parts.millisecond = 0;
    } else if (unit === 'minute') {
      parts.second = 0;
      parts.millisecond = 0;
    } else if (unit === 'second') {
      parts.millisecond = 0;
    }
    return new DraflowDateTime(zonedTimeToUtc(parts, this.timeZone), this.timeZone);
  }

  endOfMonth(): DraflowDateTime {
    const parts = getParts(this.#millis, this.timeZone);
    const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
    const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
    const firstOfNext = zonedTimeToUtc(
      {
        year: nextYear,
        month: nextMonth,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        weekday: 1,
      },
      this.timeZone,
    );
    return new DraflowDateTime(firstOfNext - 1, this.timeZone);
  }

  isWeekend(): boolean {
    const weekday = getParts(this.#millis, this.timeZone).weekday;
    return weekday === 6 || weekday === 7;
  }

  isDst(): boolean {
    const year = getParts(this.#millis, this.timeZone).year;
    const january = getOffsetMinutes(Date.UTC(year, 0, 1), this.timeZone);
    const july = getOffsetMinutes(Date.UTC(year, 6, 1), this.timeZone);
    const current = getOffsetMinutes(this.#millis, this.timeZone);
    return current > Math.min(january, july);
  }

  isBetween(start: DraflowDateTime, end: DraflowDateTime): boolean {
    return this.#millis >= start.#millis && this.#millis <= end.#millis;
  }

  get year(): number {
    return getParts(this.#millis, this.timeZone).year;
  }

  get month(): number {
    return getParts(this.#millis, this.timeZone).month;
  }

  get day(): number {
    return getParts(this.#millis, this.timeZone).day;
  }

  get hour(): number {
    return getParts(this.#millis, this.timeZone).hour;
  }

  get minute(): number {
    return getParts(this.#millis, this.timeZone).minute;
  }

  get second(): number {
    return getParts(this.#millis, this.timeZone).second;
  }

  get millisecond(): number {
    return getParts(this.#millis, this.timeZone).millisecond;
  }

  get weekday(): number {
    return getParts(this.#millis, this.timeZone).weekday;
  }

  get offset(): number {
    return getOffsetMinutes(this.#millis, this.timeZone);
  }

  get zoneName(): string {
    return this.timeZone;
  }
}

export function getOffsetMinutes(millis: number, timeZone: string): number {
  let formatter = OFFSET_CACHE.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
      hour12: false,
    });
    OFFSET_CACHE.set(timeZone, formatter);
  }

  const part = formatter
    .formatToParts(new Date(millis))
    .find((entry) => entry.type === 'timeZoneName')?.value;
  if (part === undefined) return 0;
  const match = /GMT([+-])(\d{2}):?(\d{2})/.exec(part);
  if (match === null) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export function getParts(millis: number, timeZone: string): DateTimeParts {
  let formatter = PARTS_CACHE.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    PARTS_CACHE.set(timeZone, formatter);
  }

  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(millis))) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }

  return {
    year: Number(values.year ?? 1970),
    month: Number(values.month ?? 1),
    day: Number(values.day ?? 1),
    hour: Number(values.hour ?? 0),
    minute: Number(values.minute ?? 0),
    second: Number(values.second ?? 0),
    millisecond: ((millis % 1000) + 1000) % 1000,
    weekday: weekdayNumber(values.weekday),
  };
}

export function zonedTimeToUtc(parts: DateTimeParts, timeZone: string): number {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );

  let offset = getOffsetMinutes(naive, timeZone);
  let result = naive - offset * 60_000;
  const corrected = getOffsetMinutes(result, timeZone);
  if (corrected !== offset) {
    offset = corrected;
    result = naive - offset * 60_000;
  }
  return result;
}

export function addDuration(
  millis: number,
  timeZone: string,
  duration: DurationLike,
  direction: 1 | -1,
): number {
  const months = (duration.months ?? 0) * direction;
  const years = (duration.years ?? 0) * direction;

  if (months !== 0 || years !== 0) {
    const parts = getParts(millis, timeZone);
    const totalMonths = parts.year * 12 + (parts.month - 1) + years * 12 + months;
    const year = Math.floor(totalMonths / 12);
    const month = (totalMonths % 12) + 1;
    const maxDay = daysInMonth(year, month);
    parts.year = year;
    parts.month = month;
    parts.day = Math.min(parts.day, maxDay);
    return zonedTimeToUtc(parts, timeZone);
  }

  const delta =
    ((duration.weeks ?? 0) * 7 * 86_400_000 +
      (duration.days ?? 0) * 86_400_000 +
      (duration.hours ?? 0) * 3_600_000 +
      (duration.minutes ?? 0) * 60_000 +
      (duration.seconds ?? 0) * 1_000 +
      (duration.milliseconds ?? 0)) *
    direction;

  return millis + delta;
}

export function diff(fromMillis: number, toMillis: number, unit: DateUnit): number {
  const delta = fromMillis - toMillis;
  switch (unit) {
    case 'years':
      return delta / (365.25 * 86_400_000);
    case 'months':
      return delta / (30.4375 * 86_400_000);
    case 'weeks':
      return delta / (7 * 86_400_000);
    case 'days':
      return delta / 86_400_000;
    case 'hours':
      return delta / 3_600_000;
    case 'minutes':
      return delta / 60_000;
    case 'seconds':
      return delta / 1_000;
    case 'milliseconds':
    default:
      return delta;
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayNumber(value: string | undefined): number {
  switch (value) {
    case 'Sun':
      return 7;
    case 'Mon':
      return 1;
    case 'Tue':
      return 2;
    case 'Wed':
      return 3;
    case 'Thu':
      return 4;
    case 'Fri':
      return 5;
    case 'Sat':
      return 6;
    default:
      return 1;
  }
}

function monthName(millis: number, timeZone: string, long: boolean): string {
  const cache = long ? MONTH_LONG_CACHE : MONTH_SHORT_CACHE;
  let formatter = cache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: long ? 'long' : 'short',
    });
    cache.set(timeZone, formatter);
  }
  return formatter.format(new Date(millis));
}

function weekdayName(millis: number, timeZone: string, long: boolean): string {
  const cache = long ? WEEKDAY_LONG_CACHE : WEEKDAY_SHORT_CACHE;
  let formatter = cache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: long ? 'long' : 'short',
    });
    cache.set(timeZone, formatter);
  }
  return formatter.format(new Date(millis));
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

function formatOffset(offsetMinutes: number, separator: '' | ':'): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hours = pad(Math.floor(absolute / 60), 2);
  const minutes = pad(absolute % 60, 2);
  return `${sign}${hours}${separator}${minutes}`;
}
