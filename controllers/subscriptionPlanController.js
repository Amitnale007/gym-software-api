import Plan from '../models/subscriptionPlanModel.js';
import { HttpError, text } from '../utils/validation.js';
import { pricingTerms, publicPlan } from '../utils/subscription.js';
import { objectId } from '../services/subscriptionService.js';
import { successResponse } from '../utils/response.js';

function amountInPaise(value, label) {
  const price = typeof value === 'number' ? String(value) : value;
  if (typeof price !== 'string' || !/^\d+(\.\d{1,2})?$/.test(price.trim()) || Number(price) > 10_000_000) {
    throw new HttpError(400, `${label} must be between 0 and 10000000 INR with at most two decimal places.`);
  }
  return Math.round(Number(price) * 100);
}

function planValues(body) {
  const name = text(body.name, 'Plan name', 2, 80);
  const pricePaise = amountInPaise(body.price, 'Base price');
  const code = text(body.code ?? '', 'Code', 0, 30).toUpperCase();
  if (code && !/^[A-Z0-9_-]+$/.test(code)) throw new HttpError(400, 'Code can contain only letters, numbers, hyphens, and underscores.');
  const pricing = body.pricing ?? 'FIXED';
  if (!['FIXED', 'PER_MEMBER'].includes(pricing)) throw new HttpError(400, 'Choose fixed or per-member pricing.');
  const pricePerMemberPaise = pricing === 'PER_MEMBER' ? amountInPaise(body.pricePerMember, 'Price per member') : 0;
  if (!Number.isInteger(body.durationDays) || body.durationDays < 1 || body.durationDays > 3650) {
    throw new HttpError(400, 'Duration must be a whole number between 1 and 3650 days.');
  }
  if (typeof body.isActive !== 'boolean') throw new HttpError(400, 'Plan active status must be true or false.');
  return {
    name, nameKey: name.toLowerCase(), pricePaise, code, pricing, pricePerMemberPaise,
    durationDays: body.durationDays, description: body.description == null ? '' : text(body.description, 'Description', 0, 500),
    isActive: body.isActive,
  };
}

export async function listPlans(req, res) {
  const plans = await Plan.find({ archivedAt: null, ...(req.query.active === 'true' ? { isActive: true } : {}) }).sort({ createdAt: -1 });
  return successResponse(res, 'Subscription plans loaded.', plans.map(publicPlan));
}

export async function createPlan(req, res) {
  const values = planValues({ isActive: true, ...req.body });
  return successResponse(res, 'Subscription plan created.', publicPlan(await Plan.create(values)), null, null, 201);
}

export async function updatePlan(req, res) {
  const plan = await Plan.findOne({ _id: objectId(req.params.id, 'Subscription plan'), archivedAt: null });
  if (!plan) throw new HttpError(404, 'Subscription plan not found.');
  const body = req.body || {};
  const currentPricing = pricingTerms(plan);
  const values = planValues({
    name: body.name ?? plan.name, description: body.description ?? plan.description,
    price: body.price ?? (plan.pricePaise / 100).toFixed(2),
    durationDays: body.durationDays ?? plan.durationDays, isActive: body.isActive ?? plan.isActive,
    code: body.code ?? plan.code, pricing: body.pricing ?? currentPricing.pricing,
    pricePerMember: body.pricePerMember ?? (currentPricing.pricePerMemberPaise / 100).toFixed(2),
  });
  Object.assign(plan, values);
  await plan.save();
  return successResponse(res, 'Subscription plan updated. Existing gym terms are preserved.', publicPlan(plan));
}

export async function removePlan(req, res) {
  const plan = await Plan.findOneAndUpdate({ _id: objectId(req.params.id, 'Subscription plan'), archivedAt: null }, {
    $set: { archivedAt: new Date(), isActive: false },
  }, { returnDocument: 'after' });
  if (!plan) throw new HttpError(404, 'Subscription plan not found.');
  return successResponse(res, 'Plan removed. Existing subscriptions and history are preserved.', null);
}
