import type { IsoDate } from "./domain.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function assertIso(d: string): IsoDate {
  if (!ISO.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new Error(`Not an ISO date (YYYY-MM-DD): ${d}`);
  }
  return d;
}

function toUtc(d: IsoDate): Date {
  return new Date(`${assertIso(d)}T00:00:00Z`);
}

function fromUtc(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: IsoDate, days: number): IsoDate {
  const x = toUtc(d);
  x.setUTCDate(x.getUTCDate() + days);
  return fromUtc(x);
}

/**
 * Calendar-month addition. If the target month is shorter, clamps to its last
 * day (31 Jan + 1 month = 28/29 Feb), which is the conservative reading for
 * "at least N months" notice when used as the earliest valid date.
 */
export function addMonths(d: IsoDate, months: number): IsoDate {
  const x = toUtc(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + months);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return fromUtc(x);
}

/** Whole days from a to b (positive when b is later). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

export const isBefore = (a: IsoDate, b: IsoDate) => a < b;
export const isOnOrAfter = (a: IsoDate, b: IsoDate) => a >= b;

export function todayIso(): IsoDate {
  return new Date().toISOString().slice(0, 10);
}

/** "1 May 2026" */
export function formatLong(d: IsoDate): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const x = toUtc(d);
  return `${x.getUTCDate()} ${months.at(x.getUTCMonth())} ${x.getUTCFullYear()}`;
}
