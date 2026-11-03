import { HttpError } from './httpError.js';

export const todayInIndia = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export function dateOnly(value, label = 'Start date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2100-12-31') {
    throw new HttpError(400, `${label} must be a valid date between 2000 and 2100.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new HttpError(400, `${label} is invalid.`);
  return value;
}

export function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function pricingTerms(plan) {
  const legacy = plan.pricing === 'PER_EMPLOYEE';
  return {
    pricing: legacy ? 'PER_MEMBER' : plan.pricing || 'FIXED',
    pricePerMemberPaise: (legacy ? plan.pricePerEmployeePaise : plan.pricePerMemberPaise) || 0,
  };
}

export function publicPlan(plan) {
  return {
    id: String(plan._id), name: plan.name, description: plan.description,
    pricePaise: plan.pricePaise, currency: plan.currency, durationDays: plan.durationDays,
    code: plan.code || '', ...pricingTerms(plan),
    isActive: plan.isActive, createdAt: plan.createdAt,
  };
}

export function publicSubscription(subscription, today = todayInIndia()) {
  if (!subscription) return null;
  const status = subscription.state === 'Cancelled' ? 'Cancelled'
    : subscription.startsOn > today ? 'Upcoming' : subscription.expiresOn < today ? 'Expired' : 'Active';
  return {
    planId: String(subscription.plan), planName: subscription.planName,
    pricePaise: subscription.pricePaise, currency: subscription.currency, durationDays: subscription.durationDays,
    code: subscription.code || '', ...pricingTerms(subscription),
    startsOn: subscription.startsOn, expiresOn: subscription.expiresOn, status,
  };
}

export function subscriptionSnapshot(plan, startsOn) {
  return {
    plan: plan._id, planName: plan.name, pricePaise: plan.pricePaise, currency: plan.currency,
    code: plan.code || '', ...pricingTerms(plan),
    durationDays: plan.durationDays, startsOn, expiresOn: addDays(startsOn, plan.durationDays - 1), state: 'Active',
  };
}
