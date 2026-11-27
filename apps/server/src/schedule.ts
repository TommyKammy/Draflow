import { Temporal } from '@js-temporal/polyfill';
import type { WorkflowNode } from '@draflow/core';

interface Cron {
  timezone: string;
  minute: number;
  hour: number | null;
  day: number | null;
  month: number | null;
  weekday: number | null;
}
export type Schedule = Cron | { intervalMs: number };

export function scheduleFor(node: WorkflowNode): Schedule {
  const { mode = 'interval', intervalSeconds = 60, cron, timezone } = node.parameters;
  if (mode === 'interval') {
    if (
      typeof intervalSeconds !== 'number' ||
      !Number.isSafeInteger(intervalSeconds) ||
      intervalSeconds < 1 ||
      intervalSeconds > 31_536_000
    )
      throw new Error('Interval must be 1–31536000 whole seconds');
    return { intervalMs: intervalSeconds * 1000 };
  }
  if (
    mode !== 'cron' ||
    typeof cron !== 'string' ||
    typeof timezone !== 'string' ||
    !timezone ||
    /^[+-]/.test(timezone)
  ) {
    throw new Error('Cron requires a five-field expression and an explicit named time zone');
  }
  // Validate the host's IANA time-zone support before changing the active revision.
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Expected five cron fields');
  function field(index: number, low: number, high: number) {
    const value = fields[index]!;
    if (value === '*') return null;
    if (!/^\d{1,2}$/.test(value) || Number(value) < low || Number(value) > high)
      throw new Error('Invalid cron field: ' + value);
    return Number(value);
  }
  const minute = field(0, 0, 59),
    hour = field(1, 0, 23),
    day = field(2, 1, 31),
    month = field(3, 1, 12),
    weekday = field(4, 0, 6);
  if (minute === null) throw new Error('Specify a numeric cron minute or use interval mode');
  if (day !== null && weekday !== null) throw new Error('Choose day of month or weekday');
  if (day && month && day > Temporal.PlainDate.from({ year: 2000, month, day: 1 }).daysInMonth)
    throw new Error('Impossible cron date');
  return { timezone, minute, hour, day, month, weekday };
}

// One canonical instant per matching wall minute. An earlier disambiguation resolves a fold
// to its first occurrence. In a gap the resulting wall time differs and is discarded.
function calendarTime(cron: Cron, anchor: number, direction: 1 | -1): number {
  // Include the neighboring UTC date: local offsets and folds can cross midnight.
  let date = Temporal.Instant.fromEpochMilliseconds(anchor)
    .toZonedDateTimeISO('UTC')
    .toPlainDate()
    .subtract({ days: direction });
  for (let days = 0; days < 366 * 12; days++, date = date.add({ days: direction })) {
    if (
      (cron.day !== null && date.day !== cron.day) ||
      (cron.month !== null && date.month !== cron.month) ||
      (cron.weekday !== null && date.dayOfWeek % 7 !== cron.weekday)
    )
      continue;
    for (let index = 0; index < 24; index++) {
      const hour = direction === 1 ? index : 23 - index;
      if (cron.hour !== null && hour !== cron.hour) continue;
      const wall = date.toPlainDateTime({ hour, minute: cron.minute });
      const instant = wall.toZonedDateTime(cron.timezone, { disambiguation: 'earlier' });
      if (!wall.equals(instant.toPlainDateTime())) continue;
      const time = instant.epochMilliseconds;
      if (direction === 1 ? time > anchor : time <= anchor) return time;
    }
  }
  throw new Error('Cron occurrence outside supported calendar range');
}

export function nextTime(schedule: Schedule, after: number): number {
  return 'intervalMs' in schedule ? after + schedule.intervalMs : calendarTime(schedule, after, 1);
}

export function latestDue(schedule: Schedule, firstDue: number, now: number): number {
  if (now === firstDue) return firstDue;
  return 'intervalMs' in schedule
    ? firstDue + Math.floor((now - firstDue) / schedule.intervalMs) * schedule.intervalMs
    : calendarTime(schedule, now, -1);
}
