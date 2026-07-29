/** Alarm names are prefixed so the worker can tell a note id from other alarms. */
import type { Repeat } from './notes';

export const ALARM_PREFIX = 'note:';

/**
 * Ask for notification access. Optional permission, so it is requested the first
 * time a reminder is set rather than at install. Must run inside a click handler.
 */
export function askNotificationPermission(): Promise<boolean> {
  return chrome.permissions.request({ permissions: ['notifications'] }).catch(() => false);
}

/** Hand the alarm to the worker: chrome.alarms is not available in every context. */
export function scheduleReminder(id: string, when: number | null): Promise<unknown> {
  return chrome.runtime
    .sendMessage(when ? { type: 'schedule-reminder', id, when } : { type: 'clear-reminder', id })
    .catch(() => undefined);
}

/**
 * Same clock time, `every` units later. Calendar-aware: month and year steps keep
 * the day of month, which plain millisecond arithmetic would drift off.
 */
export function nextOccurrence(from: number, repeat: Repeat): number {
  const d = new Date(from);
  const n = Math.max(1, Math.round(repeat.every));
  if (repeat.unit === 'day') d.setDate(d.getDate() + n);
  else if (repeat.unit === 'week') d.setDate(d.getDate() + 7 * n);
  else if (repeat.unit === 'month') d.setMonth(d.getMonth() + n);
  else d.setFullYear(d.getFullYear() + n);
  return d.getTime();
}

/** First occurrence after now — a missed series can be several steps behind. */
export function upcomingOccurrence(from: number, repeat: Repeat): number {
  let next = nextOccurrence(from, repeat);
  const now = Date.now();
  // Guard the loop: a 1-day repeat missed for years is still only thousands of steps.
  for (let i = 0; next <= now && i < 5000; i++) next = nextOccurrence(next, repeat);
  return next;
}

export function describeRepeat(repeat: Repeat): string {
  const plural = repeat.every === 1 ? repeat.unit : `${repeat.every} ${repeat.unit}s`;
  const every =
    repeat.every === 1
      ? { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[repeat.unit]
      : `every ${plural}`;
  return repeat.until === null
    ? every
    : `${every} until ${new Date(repeat.until).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}`;
}

/** Next whole hour in local time — epoch rounding would land off-hour in zones like +05:45. */
export function nextHour(): number {
  const d = new Date(Date.now() + 60_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

/** `2026-07-29T09:00` in local time, which is what datetime-local expects. */
export function toInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatReminder(ms: number): string {
  const when = new Date(ms);
  const today = new Date();
  const sameDay = when.toDateString() === today.toDateString();
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  const tomorrow = new Date(today.getTime() + 86400000);
  if (when.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${time}`;
  const date = when.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: when.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
  return `${date}, ${time}`;
}
