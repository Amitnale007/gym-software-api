import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import MemberPlan from '../models/memberPlanModel.js';
import Member from '../models/memberModel.js';
import MemberHistory from '../models/memberHistoryModel.js';
import User from '../models/userModel.js';
import Session from '../models/sessionModel.js';
import { email, password, text, HttpError } from '../utils/validation.js';
import { dateOnly, todayInIndia } from '../utils/subscription.js';
import { objectId } from '../services/subscriptionService.js';
import { successResponse } from '../utils/response.js';
import { monthExpiry, planMonths } from '../utils/memberDuration.js';
import { ensureMemberCounter, memberCode, nextMemberNumber } from '../services/memberNumberService.js';

function price(value) {
  const amount = typeof value === 'number' ? String(value) : value;
  if (typeof amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amount.trim()) || Number(amount) > 10_000_000) throw new HttpError(400, 'Enter a price from 0 to 10000000 INR with at most two decimals.');
  return Math.round(Number(amount) * 100);
}
function boolean(value, label) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${label} must be true or false.`);
  return value;
}
function planValues(body) {
  const name = text(body.name, 'Plan name', 2, 80);
  const code = text(body.code, 'Code', 1, 30).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(code)) throw new HttpError(400, 'Code must contain letters, numbers, hyphens, or underscores.');
  if (!Number.isInteger(body.durationMonths) || body.durationMonths < 1 || body.durationMonths > 12) throw new HttpError(400, 'Choose a whole number of months from 1 to 12.');
  return { name, nameKey: name.toLowerCase(), code, description: text(body.description ?? '', 'Description', 0, 500), pricePaise: price(body.price), durationMonths: body.durationMonths, isActive: boolean(body.isActive ?? true, 'Active status') };
}
function publicPlan(plan) {
  return { id: String(plan._id), name: plan.name, code: plan.code, description: plan.description, pricePaise: plan.pricePaise, durationMonths: planMonths(plan), isActive: plan.isActive, createdAt: plan.createdAt };
}
export async function listMemberPlans(req, res) {
  const plans = await MemberPlan.find({ gym: req.user.gym, archivedAt: null }).sort({ createdAt: -1 });
  return successResponse(res, 'Member subscription plans loaded.', plans.map(publicPlan));
}
export async function createMemberPlan(req, res) {
  return successResponse(res, 'Member subscription plan created.', publicPlan(await MemberPlan.create({ ...planValues(req.body || {}), gym: req.user.gym })), null, null, 201);
}
export async function updateMemberPlan(req, res) {
  const plan = await MemberPlan.findOne({ _id: objectId(req.params.id, 'Plan'), gym: req.user.gym, archivedAt: null });
  if (!plan) throw new HttpError(404, 'Member plan not found.');
  Object.assign(plan, planValues({ name: plan.name, code: plan.code, description: plan.description, price: (plan.pricePaise / 100).toFixed(2), durationMonths: planMonths(plan), isActive: plan.isActive, ...req.body }));
  plan.durationDays = undefined;
  await plan.save();
  return successResponse(res, 'Member plan updated. Existing memberships keep their saved terms.', publicPlan(plan));
}
export async function removeMemberPlan(req, res) {
  const plan = await MemberPlan.findOneAndUpdate({ _id: objectId(req.params.id, 'Plan'), gym: req.user.gym, archivedAt: null }, { $set: { isActive: false, archivedAt: new Date() } });
  if (!plan) throw new HttpError(404, 'Member plan not found.');
  return successResponse(res, 'Plan removed from future use. Existing memberships remain.', null);
}

function publicTrainer(user) { return { id: String(user._id), name: user.name, email: user.email, isActive: user.isActive !== false }; }
export async function listTrainers(req, res) {
  return successResponse(res, 'Trainers loaded.', (await User.find({ gym: req.user.gym, role: 'TRAINER' }).sort({ name: 1 })).map(publicTrainer));
}
export async function createTrainer(req, res) {
  const body = req.body || {};
  const user = await User.create({ name: text(body.name, 'Trainer name', 2, 80), email: email(body.email), passwordHash: await bcrypt.hash(password(body.password), 12), gym: req.user.gym, role: 'TRAINER', isActive: true });
  return successResponse(res, 'Trainer account created.', publicTrainer(user), null, null, 201);
}
export async function updateTrainer(req, res) {
  const active = boolean(req.body?.isActive, 'Trainer active status');
  let result;
  await mongoose.connection.transaction(async (session) => {
    const trainer = await User.findOneAndUpdate({ _id: objectId(req.params.id, 'Trainer'), gym: req.user.gym, role: 'TRAINER' }, { $set: { isActive: active } }, { session, returnDocument: 'after' });
    if (!trainer) throw new HttpError(404, 'Trainer not found.');
    if (!active) {
      await Session.deleteMany({ user: trainer._id }).session(session);
      await Member.updateMany({ gym: req.user.gym, trainer: trainer._id }, { $set: { trainer: null }, $inc: { revision: 1 } }).session(session);
    }
    result = publicTrainer(trainer);
  });
  return successResponse(res, 'Trainer updated.', result);
}

export function memberScope(req) {
  const filter = { gym: req.user.gym, deletedAt: null };
  if (req.user.role === 'TRAINER') filter.trainer = req.user._id;
  if (req.user.role === 'MEMBER') filter.user = req.user._id;
  return filter;
}
function membershipView(value) {
  return { planId: String(value.plan), planName: value.planName, pricePaise: value.pricePaise, ...(value.durationMonths ? { durationMonths: value.durationMonths } : { durationDays: value.durationDays }), startsOn: value.startsOn, expiresOn: value.expiresOn };
}
export function memberView(member) {
  const today = todayInIndia();
  return {
    id: String(member._id), memberCode: member.memberCode || memberCode(member.memberNumber),
    name: member.name, email: member.email, phone: member.phone, address: member.address, joinedOn: member.joinedOn,
    trainer: member.trainer?.name ? { id: String(member.trainer._id), name: member.trainer.name } : null,
    hasLogin: Boolean(member.user), isActive: member.isActive, revision: member.revision,
    status: !member.isActive ? 'Inactive' : member.membership.startsOn > today ? 'Upcoming' : member.membership.expiresOn < today ? 'Expired' : 'Active',
    membership: membershipView(member.membership),
  };
}
async function trainerId(value, gym, session) {
  if (value == null || value === '') return null;
  const trainer = await User.exists({ _id: objectId(value, 'Trainer'), gym, role: 'TRAINER', isActive: { $ne: false } }).session(session);
  if (!trainer) throw new HttpError(400, 'Choose an active trainer from your gym.');
  return value;
}
async function membershipFor(planId, gym, start, session) {
  const plan = await MemberPlan.findOne({ _id: objectId(planId, 'Member plan'), gym, isActive: true, archivedAt: null }).session(session);
  if (!plan) throw new HttpError(400, 'Choose an active member plan from your gym.');
  const months = planMonths(plan);
  return { plan: plan._id, planName: plan.name, pricePaise: plan.pricePaise, durationMonths: months, startsOn: start, expiresOn: monthExpiry(start, months) };
}
function profileValues(body) {
  const phone = text(body.phone, 'Phone', 7, 20);
  const optionalEmail = text(body.email ?? '', 'Email', 0, 254);
  if (!/^\+?[\d ()-]{7,20}$/.test(phone)) throw new HttpError(400, 'Enter a valid phone number.');
  return { name: text(body.name, 'Name', 2, 80), phone, email: optionalEmail ? email(optionalEmail) : '', address: text(body.address ?? '', 'Address', 0, 300), joinedOn: dateOnly(body.joinedOn, 'Joining date'), isActive: boolean(body.isActive ?? true, 'Member active status') };
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, 'A valid member revision is required.');
  return value;
}
async function loadedMember(id, gym) { return Member.findOne({ _id: id, gym, deletedAt: null }).populate('trainer', 'name'); }

export async function listMembers(req, res) {
  const filter = memberScope(req);
  const today = todayInIndia();
  const status = req.query.status;
  if (status && !['Active', 'Upcoming', 'Expired', 'Inactive'].includes(status)) throw new HttpError(400, 'Invalid member status.');
  if (status === 'Inactive') filter.isActive = false;
  if (status && status !== 'Inactive') {
    filter.isActive = true;
    if (status === 'Upcoming') filter['membership.startsOn'] = { $gt: today };
    else if (status === 'Expired') filter['membership.expiresOn'] = { $lt: today };
    else { filter['membership.startsOn'] = { $lte: today }; filter['membership.expiresOn'] = { $gte: today }; }
  }
  if (req.query.planId) filter['membership.plan'] = objectId(req.query.planId, 'Member plan');
  if (req.query.trainerId && req.user.role === 'GYMADMIN') filter.trainer = objectId(req.query.trainerId, 'Trainer');
  if (req.query.search) {
    const search = text(req.query.search, 'Search', 0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = ['name', 'email', 'phone'].map((field) => ({ [field]: { $regex: search, $options: 'i' } }));
    filter.$or.push({ memberCode: { $regex: search, $options: 'i' } });
  }
  const pageSize = [5, 10, 25, 50, 100].includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 10;
  const total = await Member.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requested = Number(req.query.page);
  const page = Math.min(totalPages, Number.isSafeInteger(requested) && requested > 0 ? requested : 1);
  const members = await Member.find(filter).populate('trainer', 'name').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize);
  return res.json({ success: true, message: 'Members loaded.', data: members.map(memberView), meta: { pagination: { pageNumber: page, pageSize, total, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 } } });
}
export async function createMember(req, res) {
  const body = req.body || {};
  const values = profileValues(body);
  const startsOn = dateOnly(body.startsOn);
  if (startsOn < values.joinedOn) throw new HttpError(400, 'Membership must start on or after the joining date.');
  const createLogin = boolean(body.createLogin ?? false, 'Create login');
  if (createLogin && !values.email) throw new HttpError(400, 'Email is required to create a member login.');
  const passwordHash = createLogin ? await bcrypt.hash(password(body.password), 12) : null;
  const id = new mongoose.Types.ObjectId();
  await ensureMemberCounter(req.user.gym);
  await mongoose.connection.transaction(async (session) => {
    const trainer = await trainerId(body.trainerId, req.user.gym, session);
    const membership = await membershipFor(body.planId, req.user.gym, startsOn, session);
    let user = null;
    if (createLogin) {
      const [account] = await User.create([{ name: values.name, email: values.email, passwordHash, role: 'MEMBER', gym: req.user.gym, isActive: values.isActive }], { session });
      user = account._id;
    }
    const numbering = await nextMemberNumber(req.user.gym, session);
    await Member.create([{ _id: id, ...values, gym: req.user.gym, ...numbering, trainer, user, membership }], { session });
    await MemberHistory.create([{ gym: req.user.gym, member: id, action: 'Joined', membership, changedBy: req.user._id }], { session });
  });
  return successResponse(res, 'Member created.', memberView(await loadedMember(id, req.user.gym)), null, null, 201);
}
export async function updateMember(req, res) {
  const body = req.body || {};
  const id = objectId(req.params.id, 'Member');
  const expected = revision(body.revision);
  const values = profileValues(body);
  const createLogin = boolean(body.createLogin ?? false, 'Create login');
  // Passwords are used only for newly enabled logins, never to reset existing accounts.
  const passwordHash = createLogin && body.password ? await bcrypt.hash(password(body.password), 12) : null;
  await mongoose.connection.transaction(async (session) => {
    const member = await Member.findOne({ _id: id, gym: req.user.gym, deletedAt: null }).session(session);
    if (!member) throw new HttpError(404, 'Member not found.');
    if (member.revision !== expected) throw new HttpError(409, 'Member changed. Refresh and try again.');
    const trainer = await trainerId(body.trainerId, req.user.gym, session);
    let user = member.user;
    if (user) {
      if (!values.email) throw new HttpError(400, 'Email is required for the existing member login.');
      await User.updateOne({ _id: user, gym: req.user.gym, role: 'MEMBER' }, { $set: { name: values.name, email: values.email, isActive: values.isActive } }).session(session);
      if (!values.isActive) await Session.deleteMany({ user }).session(session);
    } else if (createLogin) {
      if (!values.email || !passwordHash) throw new HttpError(400, 'Email and a password of at least 8 characters are required for member login.');
      const [account] = await User.create([{ name: values.name, email: values.email, passwordHash, role: 'MEMBER', gym: req.user.gym, isActive: values.isActive }], { session });
      user = account._id;
    }
    const updated = await Member.updateOne({ _id: id, gym: req.user.gym, revision: expected }, { $set: { ...values, trainer, user }, $inc: { revision: 1 } }).session(session);
    if (updated.modifiedCount !== 1) throw new HttpError(409, 'Member changed. Refresh and try again.');
  });
  return successResponse(res, 'Member updated.', memberView(await loadedMember(id, req.user.gym)));
}
export async function renewMember(req, res) {
  const id = objectId(req.params.id, 'Member');
  const body = req.body || {};
  const expected = revision(body.revision);
  await mongoose.connection.transaction(async (session) => {
    const member = await Member.findOne({ _id: id, gym: req.user.gym, deletedAt: null }).session(session);
    if (!member) throw new HttpError(404, 'Member not found.');
    if (member.revision !== expected) throw new HttpError(409, 'Member changed. Refresh and try again.');
    if (!member.isActive) throw new HttpError(400, 'Activate the member before renewing.');
    const planId = objectId(body.planId || String(member.membership.plan), 'Member plan').toLowerCase();
    const samePlan = planId === String(member.membership.plan);
    const today = todayInIndia();
    const membership = await membershipFor(planId, req.user.gym, today, session);
    if (samePlan && member.membership.expiresOn >= today) throw new HttpError(409, `This plan is already active or scheduled through ${member.membership.expiresOn}. Renew after expiry, or select a different plan to replace it.`);
    const previousMembership = member.membership.toObject();
    const updated = await Member.updateOne({ _id: id, gym: req.user.gym, revision: expected }, { $set: { membership }, $inc: { revision: 1 } }).session(session);
    if (updated.modifiedCount !== 1) throw new HttpError(409, 'Member changed. Refresh and try again.');
    if (!samePlan) await MemberHistory.updateMany({ gym: req.user.gym, member: id, closedAt: null, 'membership.expiresOn': { $gte: today } }, { $set: { closedAt: new Date(), closedOn: today, closureReason: 'Replaced' } }).session(session);
    await MemberHistory.create([{ gym: req.user.gym, member: id, action: samePlan ? 'Renewed' : 'Changed', membership, previousMembership, changedBy: req.user._id }], { session });
  });
  return successResponse(res, 'Membership saved.', memberView(await loadedMember(id, req.user.gym)));
}
export async function memberHistory(req, res) {
  const id = objectId(req.params.id, 'Member');
  const member = await Member.findOne({ ...memberScope(req), _id: id });
  if (!member) throw new HttpError(404, 'Member not found.');
  const history = await MemberHistory.find({ gym: req.user.gym, member: id }).populate('changedBy', 'name').sort({ createdAt: -1, _id: -1 }).limit(100);
  const today = todayInIndia();
  return successResponse(res, 'Membership history loaded.', history.map((item, index) => ({
    id: String(item._id), action: item.action, membership: membershipView(item.membership), previousMembership: item.previousMembership ? membershipView(item.previousMembership) : null,
    status: item.closedAt ? 'Closed' : item.membership.expiresOn < today ? 'Expired' : index > 0 ? 'Closed' : !member.isActive ? 'Inactive' : item.membership.startsOn > today ? 'Upcoming' : 'Active',
    closedOn: item.closedOn, closureReason: item.closureReason,
    changedBy: item.changedBy?.name || 'Gym Admin', createdAt: item.createdAt,
  })));
}

export async function deleteMember(req, res) {
  const id = objectId(req.params.id, 'Member');
  const expected = revision(req.body?.revision);
  await mongoose.connection.transaction(async (session) => {
    const member = await Member.findOne({ _id: id, gym: req.user.gym, deletedAt: null }).session(session);
    if (!member) throw new HttpError(404, 'Member not found.');
    if (member.revision !== expected) throw new HttpError(409, 'Member changed. Refresh and try again.');
    const result = await Member.updateOne({ _id: id, gym: req.user.gym, deletedAt: null, revision: expected }, { $set: { deletedAt: new Date(), isActive: false, trainer: null }, $inc: { revision: 1 } }).session(session);
    if (result.modifiedCount !== 1) throw new HttpError(409, 'Member changed. Refresh and try again.');
    if (member.user) {
      await User.updateOne({ _id: member.user, gym: req.user.gym, role: 'MEMBER' }, { $set: { isActive: false } }).session(session);
      await Session.deleteMany({ user: member.user }).session(session);
    }
  });
  return successResponse(res, 'Member deleted. Login disabled and membership history retained.', null);
}
