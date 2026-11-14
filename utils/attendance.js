import { addDays, dateOnly, todayInIndia } from './subscription.js';
import { HttpError } from './validation.js';

export const QR_PREFIX = 'GYMATTEND:1:';
export const REPUNCH_DELAY_MS = 60_000;
export function attendanceDay(value = todayInIndia()) {
  const date = dateOnly(value, 'Attendance date');
  if (date > todayInIndia()) throw new HttpError(400, 'Attendance date cannot be in the future.');
  return { date, start: new Date(`${date}T00:00:00+05:30`), end: new Date(`${addDays(date, 1)}T00:00:00+05:30`) };
}
export function qrToken(value) {
  if (typeof value !== 'string' || !new RegExp(`^${QR_PREFIX}[a-f0-9]{64}$`).test(value)) throw new HttpError(400, 'Scan a valid gym member attendance QR code.');
  return value.slice(QR_PREFIX.length);
}
export function dayMinutes(item, start, end, now = new Date()) {
  const from = Math.max(new Date(item.checkedInAt).getTime(), start.getTime());
  const to = Math.min(item.checkedOutAt ? new Date(item.checkedOutAt).getTime() : now.getTime(), end.getTime(), now.getTime());
  return Math.max(0, Math.floor((to - from) / 60_000));
}
export function csvCell(value) {
  // Spreadsheet exports must not execute user-entered names or member codes as formulas.
  const raw = String(value ?? '');
  const safe = /^[\s]*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
