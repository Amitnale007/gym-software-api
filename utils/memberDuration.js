// Existing plan masters are presented in months without rewriting purchased terms.
export const planMonths = (plan) => plan.durationMonths || Math.min(12, Math.max(1, Math.round((plan.durationDays || 30) / 30)));

export function monthExpiry(startsOn, months) {
  const start = new Date(`${startsOn}T00:00:00Z`);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = start.getUTCDate();
  // Inclusive expiry: day before the anniversary; clamp missing dates to month-end.
  target.setUTCDate(day > lastDay ? lastDay : day - 1);
  return target.toISOString().slice(0, 10);
}
