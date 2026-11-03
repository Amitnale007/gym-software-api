import mongoose from 'mongoose';
import Plan from '../models/subscriptionPlanModel.js';
import History from '../models/subscriptionHistoryModel.js';
import { HttpError } from '../utils/validation.js';
import { dateOnly, subscriptionSnapshot } from '../utils/subscription.js';

export function objectId(value, label) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new HttpError(400, `${label} is invalid.`);
  return value;
}

export async function activePlan(planId, session) {
  objectId(planId, 'Subscription plan');
  const plan = await Plan.findOne({ _id: planId, isActive: true, archivedAt: null }).session(session);
  if (!plan) throw new HttpError(400, 'Choose an active subscription plan.');
  return plan;
}

export async function assignedSubscription(planId, startsOn, session) {
  const start = dateOnly(startsOn);
  const plan = await activePlan(planId, session);
  return subscriptionSnapshot(plan, start);
}

export async function recordSubscriptionChange({ gym, actor, action, subscription, previousSubscription = null, periodStartsOn, periodExpiresOn }, session) {
  await History.create([{
    gym, changedBy: actor, action, subscription, previousSubscription,
    periodStartsOn: periodStartsOn || subscription.startsOn, periodExpiresOn: periodExpiresOn || subscription.expiresOn,
  }], { session });
}

export const transaction = (callback) => mongoose.connection.transaction(callback);
