import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../app.js';
import User from '../models/userModel.js';
import Gym from '../models/gymModel.js';
import Session from '../models/sessionModel.js';
import MemberPlan from '../models/memberPlanModel.js';
import Member from '../models/memberModel.js';
import MemberHistory from '../models/memberHistoryModel.js';
import MemberCounter from '../models/memberCounterModel.js';
import { backfillMemberNumbers } from '../services/memberNumberService.js';
import { addDays, todayInIndia } from '../utils/subscription.js';
import { monthExpiry, planMonths } from '../utils/memberDuration.js';

let database, server, base, admin, otherAdmin, superadmin, gym, otherGym, trainer, otherTrainer, trainerLogin, memberLogin, plan, otherPlan, member, loginMember;
const secret = 'Testing123!';
async function request(path, token, method = 'GET', body) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function signIn(email) {
  const response = await request('/auth/login', null, 'POST', { email, password: secret });
  assert.equal(response.status, 200);
  return response.body.data;
}
const planValues = () => ({ name: 'Monthly Fitness', code: 'MONTHLY', price: '500.25', durationMonths: 1, isActive: true });
const memberValues = (suffix = 'one') => ({ name: `Member ${suffix}`, phone: '+91 9876543210', email: '', address: '', joinedOn: todayInIndia(), planId: plan.id, startsOn: todayInIndia(), trainerId: trainer.id, isActive: true, createLogin: false });
const profile = (value) => ({ name: value.name, email: value.email, phone: value.phone, address: value.address, joinedOn: value.joinedOn, trainerId: value.trainer?.id || '', isActive: value.isActive, revision: value.revision, createLogin: false });

before(async () => {
  process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
  process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri(), { dbName: 'member-management-tests' });
  await Promise.all([User.init(), Gym.init(), Session.init(), MemberPlan.init(), Member.init(), MemberHistory.init(), MemberCounter.init()]);
  const passwordHash = await bcrypt.hash(secret, 4);
  gym = new mongoose.Types.ObjectId(); otherGym = new mongoose.Types.ObjectId();
  const root = await User.create({ name: 'Root', email: 'root@example.test', role: 'SUPERADMIN', passwordHash });
  const first = await User.create({ name: 'First Admin', email: 'first@example.test', role: 'GYMADMIN', gym, passwordHash });
  const second = await User.create({ name: 'Second Admin', email: 'second@example.test', role: 'GYMADMIN', gym: otherGym, passwordHash });
  await Gym.create([
    { _id: gym, name: 'First Gym', email: 'first-gym@example.test', phone: '9876543210', admin: first._id, createdBy: root._id },
    { _id: otherGym, name: 'Second Gym', email: 'second-gym@example.test', phone: '9876543211', admin: second._id, createdBy: root._id },
  ]);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  admin = (await signIn(first.email)).accessToken;
  otherAdmin = (await signIn(second.email)).accessToken;
  superadmin = (await signIn(root.email)).accessToken;
}, { timeout: 120_000 });
after(async () => { if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } await mongoose.disconnect(); if (database) await database.stop(); });

describe('Gym-wise member plans and trainer accounts', { concurrency: false }, () => {
  it('uses exactly four persisted roles', async () => {
    assert.deepEqual(User.schema.path('role').enumValues, ['SUPERADMIN', 'GYMADMIN', 'TRAINER', 'MEMBER']);
  });
  it('scopes plan masters to the signed-in gym and allows identical names across gyms', async () => {
    const first = await request('/member-plans', admin, 'POST', { ...planValues(), gym: String(otherGym) });
    assert.equal(first.status, 201); plan = first.body.data;
    otherPlan = (await request('/member-plans', otherAdmin, 'POST', planValues())).body.data;
    assert.equal(String((await MemberPlan.findById(plan.id)).gym), String(gym));
    assert.equal((await request('/member-plans', admin)).body.data.length, 1);
    assert.equal((await request('/member-plans', otherAdmin)).body.data[0].id, otherPlan.id);
    assert.equal((await request('/member-plans', admin, 'POST', { ...planValues(), name: ' monthly fitness ' })).status, 409);
  });
  it('blocks cross-gym plan updates, removal, and invalid plan values', async () => {
    assert.equal((await request(`/member-plans/${otherPlan.id}`, admin, 'PATCH', { price: '1' })).status, 404);
    assert.equal((await request(`/member-plans/${otherPlan.id}`, admin, 'DELETE')).status, 404);
    for (const invalid of [{ price: '-1' }, { price: '1.001' }, { price: '10000001' }, { code: 'BAD CODE' }, { durationMonths: 0 }, { durationMonths: 1.5 }, { durationMonths: 13 }, { isActive: 'true' }]) {
      assert.equal((await request('/member-plans', admin, 'POST', { ...planValues(), name: 'Bad', ...invalid })).status, 400);
    }
  });
  it('creates trainer accounts with server-assigned role and gym', async () => {
    const result = await request('/trainers', admin, 'POST', { name: 'Trainer One', email: 'trainer@example.test', password: secret, role: 'SUPERADMIN', gym: String(otherGym) });
    assert.equal(result.status, 201); trainer = result.body.data;
    trainerLogin = (await signIn(trainer.email)).accessToken;
    const stored = await User.findById(trainer.id).select('+passwordHash');
    assert.equal(stored.role, 'TRAINER'); assert.equal(String(stored.gym), String(gym));
    assert.notEqual(stored.passwordHash, secret);
    otherTrainer = (await request('/trainers', otherAdmin, 'POST', { name: 'Trainer Two', email: 'other-trainer@example.test', password: secret })).body.data;
    assert.equal((await request('/trainers', admin)).body.data.length, 1);
    assert.equal((await request(`/trainers/${otherTrainer.id}`, admin, 'PATCH', { isActive: false })).status, 404);
  });
  it('requires gym-admin permission for plan and trainer management', async () => {
    for (const path of ['/member-plans', '/trainers', '/members']) assert.equal((await request(path, null)).status, 401);
    for (const token of [superadmin, trainerLogin]) {
      assert.equal((await request('/member-plans', token)).status, 403);
      assert.equal((await request('/trainers', token, 'POST', { name: 'Forbidden' })).status, 403);
      assert.equal((await request('/members', token, 'POST', {})).status, 403);
    }
    assert.equal((await request('/members', superadmin)).status, 403);
  });
});

describe('Member registration, assignment, and tenant isolation', { concurrency: false }, () => {
  it('registers a member without email or login, calculating terms from the gym master', async () => {
    const result = await request('/members', admin, 'POST', { ...memberValues(), gym: String(otherGym), role: 'SUPERADMIN', membership: { pricePaise: 1 }, expiresOn: '2099-01-01' });
    assert.equal(result.status, 201); member = result.body.data;
    assert.equal(member.memberCode, 'MEM0001');
    assert.equal(member.email, ''); assert.equal(member.hasLogin, false);
    assert.equal(member.membership.pricePaise, 50025);
    assert.equal(member.membership.expiresOn, monthExpiry(todayInIndia(), 1));
    assert.equal(member.trainer.id, trainer.id);
    assert.equal(String((await Member.findById(member.id)).gym), String(gym));
    assert.equal(await MemberHistory.countDocuments({ member: member.id }), 1);
  });
  it('rejects foreign plans, trainers, bad contact data, and price injection', async () => {
    for (const invalid of [{ planId: otherPlan.id }, { trainerId: otherTrainer.id }, { email: { $ne: null } }, { phone: 'bad' }, { joinedOn: '2026-02-30' }, { joinedOn: addDays(todayInIndia(), 2) }, { createLogin: 'true' }]) {
      assert.equal((await request('/members', admin, 'POST', { ...memberValues('invalid'), ...invalid })).status, 400);
    }
    assert.equal(await Member.countDocuments(), 1);
  });
  it('creates an optional member login and returns no credential fields', async () => {
    const result = await request('/members', admin, 'POST', { ...memberValues('login'), email: 'member@example.test', createLogin: true, password: secret, role: 'TRAINER' });
    assert.equal(result.status, 201); loginMember = result.body.data;
    const signed = await signIn(loginMember.email); memberLogin = signed.accessToken;
    assert.equal(signed.user.role, 'MEMBER');
    assert.equal(loginMember.hasLogin, true); assert.equal(result.body.data.passwordHash, undefined);
  });
  it('rejects incomplete or duplicate member logins without leaving profiles behind', async () => {
    const count = await Member.countDocuments();
    for (const invalid of [{ email: '', password: secret }, { email: 'weak@example.test', password: 'short' }, { email: 'member@example.test', password: secret }]) {
      const response = await request('/members', admin, 'POST', { ...memberValues('invalid-login'), createLogin: true, ...invalid });
      assert.ok([400, 409].includes(response.status));
    }
    assert.equal(await Member.countDocuments(), count);
  });
  it('enforces own-profile and assigned-member visibility on lists and history', async () => {
    const unassigned = await request('/members', admin, 'POST', { ...memberValues('unassigned'), trainerId: '' });
    assert.equal(unassigned.status, 201);
    assert.equal((await request('/members', otherAdmin)).body.data.length, 0);
    assert.equal((await request('/members', trainerLogin)).body.data.length, 2);
    const own = await request('/members', memberLogin);
    assert.equal(own.body.data.length, 1); assert.equal(own.body.data[0].id, loginMember.id);
    assert.equal((await request(`/members/${member.id}/history`, otherAdmin)).status, 404);
    assert.equal((await request(`/members/${member.id}/history`, memberLogin)).status, 404);
    assert.equal((await request(`/members/${unassigned.body.data.id}/history`, trainerLogin)).status, 404);
    assert.equal((await request(`/members/${loginMember.id}/history`, memberLogin)).status, 200);
    for (const token of [memberLogin, trainerLogin]) {
      assert.equal((await request(`/members/${member.id}`, token, 'PATCH', profile(member))).status, 403);
      assert.equal((await request(`/members/${member.id}/renew`, token, 'POST', { revision: 0 })).status, 403);
      assert.equal((await request('/member-plans', token)).status, 403);
    }
  });
  it('filters before pagination and treats search characters literally', async () => {
    const found = await request('/members?search=login&pageSize=5&page=999&status=Active', admin);
    assert.equal(found.body.data.length, 1);
    assert.equal(found.body.meta.pagination.pageNumber, 1);
    assert.equal((await request('/members?search=.*', admin)).body.data.length, 0);
    assert.equal((await request(`/members?trainerId=${trainer.id}`, admin)).body.data.length, 2);
    assert.equal((await request('/members?status=BAD', admin)).status, 400);
  });
  it('keeps cross-gym edits and membership history inaccessible', async () => {
    assert.equal((await request(`/members/${member.id}`, otherAdmin, 'PATCH', profile(member))).status, 404);
    assert.equal((await request(`/members/${member.id}/renew`, otherAdmin, 'POST', { revision: 0 })).status, 404);
    assert.equal((await request(`/members/${member.id}`, admin, 'PATCH', { ...profile(member), trainerId: otherTrainer.id })).status, 400);
  });
  it('rolls back profile and login creation if recording history fails', async (t) => {
    const count = await Member.countDocuments(); const users = await User.countDocuments();
    const counter = (await MemberCounter.findById(gym)).value;
    t.mock.method(MemberHistory, 'create', async () => { throw new Error('Simulated history failure'); });
    const result = await request('/members', admin, 'POST', { ...memberValues('rollback'), createLogin: true, email: 'rollback@example.test', password: secret });
    assert.equal(result.status, 500);
    assert.equal(await Member.countDocuments(), count); assert.equal(await User.countDocuments(), users);
    assert.equal((await MemberCounter.findById(gym)).value, counter);
    t.mock.restoreAll();
  });
  it('can enable login later without changing the server-controlled role', async () => {
    const result = await request(`/members/${member.id}`, admin, 'PATCH', { ...profile(member), email: 'later@example.test', createLogin: true, password: secret, role: 'SUPERADMIN', gym: String(otherGym) });
    assert.equal(result.status, 200); member = result.body.data;
    assert.equal(member.hasLogin, true); assert.equal((await signIn(member.email)).user.role, 'MEMBER');
  });
  it('deactivates member login and revokes existing sessions', async () => {
    const result = await request(`/members/${loginMember.id}`, admin, 'PATCH', { ...profile(loginMember), isActive: false });
    assert.equal(result.status, 200); loginMember = result.body.data;
    assert.equal(loginMember.status, 'Inactive');
    assert.equal((await request('/members', memberLogin)).status, 401);
    assert.equal((await request('/auth/login', null, 'POST', { email: loginMember.email, password: secret })).status, 403);
    assert.equal((await request(`/members/${loginMember.id}/renew`, admin, 'POST', { revision: loginMember.revision })).status, 400);
  });
});

describe('Gym-wise member ID master and numbering', { concurrency: false }, () => {
  it('starts each gym at MEM0001 and searches by the short ID', async () => {
    const created = await request('/members', otherAdmin, 'POST', { ...memberValues('other-gym-number'), trainerId: '', planId: otherPlan.id });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.memberCode, 'MEM0001');
    const found = await request('/members?search=mem0001', otherAdmin);
    assert.equal(found.body.data.length, 1);
    assert.equal(found.body.data[0].id, created.body.data.id);
  });
  it('upgrades older counter records without resetting their sequence', async () => {
    await MemberCounter.collection.updateOne({ _id: otherGym }, { $unset: { prefix: '', padding: '', settingsRevision: '' } });
    const response = await request('/member-id-settings', otherAdmin);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.prefix, 'MEM');
    assert.equal(response.body.data.preview, 'MEM0002');
    const saved = await request('/member-id-settings', otherAdmin, 'PATCH', response.body.data);
    assert.equal(saved.status, 200);
  });
  it('limits ID settings to the Gym Admin and validates the format and sequence', async () => {
    assert.equal((await request('/member-id-settings', null)).status, 401);
    assert.equal((await request('/member-id-settings', superadmin)).status, 403);
    const activeTrainer = await request('/trainers', admin, 'POST', { name: 'ID Trainer', email: 'id-trainer@example.test', password: secret });
    const trainerToken = (await signIn(activeTrainer.body.data.email)).accessToken;
    assert.equal((await request('/member-id-settings', trainerToken)).status, 403);
    const settings = (await request('/member-id-settings', admin)).body.data;
    assert.equal(settings.prefix, 'MEM'); assert.equal(settings.padding, 4);
    for (const invalid of [{ prefix: 'MEM-' }, { prefix: 'MEM1' }, { padding: 0 }, { padding: 9 }, { nextNumber: 0 }, { nextNumber: 1 }, { nextNumber: 1.5 }]) {
      assert.equal((await request('/member-id-settings', admin, 'PATCH', { ...settings, ...invalid })).status, 400);
    }
    assert.equal((await request('/member-id-settings', admin, 'PATCH', { ...settings, revision: settings.revision + 1 })).status, 409);
  });
  it('applies custom settings only to future members in the owning gym', async () => {
    const before = await Member.findOne({ gym, deletedAt: null });
    const settings = (await request('/member-id-settings', admin)).body.data;
    const saved = await request('/member-id-settings', admin, 'PATCH', { prefix: 'FIT', padding: 5, nextNumber: 500, revision: settings.revision, gym: String(otherGym) });
    assert.equal(saved.status, 200); assert.equal(saved.body.data.preview, 'FIT00500');
    const created = await request('/members', admin, 'POST', { ...memberValues('custom-code'), trainerId: '', memberNumber: 1, memberCode: 'HACK0001' });
    assert.equal(created.status, 201); assert.equal(created.body.data.memberCode, 'FIT00500');
    assert.equal((await Member.findById(before._id)).memberCode, before.memberCode);
    assert.equal((await request('/member-id-settings', otherAdmin)).body.data.prefix, 'MEM');
    assert.equal((await request('/members?search=fit00500', admin)).body.data[0].id, created.body.data.id);
  });
  it('assigns distinct consecutive IDs to concurrent registrations', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => request('/members', admin, 'POST', { ...memberValues(`parallel-${index}`), trainerId: '' })));
    assert.ok(results.every((result) => result.status === 201), JSON.stringify(results.map((result) => ({ status: result.status, message: result.body.message }))));
    assert.deepEqual(results.map((result) => result.body.data.memberCode).sort(), ['FIT00501', 'FIT00502', 'FIT00503', 'FIT00504', 'FIT00505']);
  });
  it('backfills existing and deleted records once without renumbering or changing membership terms', async () => {
    const source = await Member.findOne({ gym, deletedAt: null });
    const values = { gym, name: 'Legacy member', phone: '9876543210', joinedOn: todayInIndia(), membership: source.membership.toObject() };
    const legacy = await Member.create(values);
    const deleted = await Member.create({ ...values, name: 'Deleted legacy', deletedAt: new Date(), isActive: false });
    await backfillMemberNumbers();
    const first = await Member.findById(legacy._id); const second = await Member.findById(deleted._id);
    assert.equal(first.memberCode, 'FIT00506'); assert.equal(second.memberCode, 'FIT00507');
    assert.deepEqual(first.membership.toObject(), source.membership.toObject());
    await backfillMemberNumbers();
    assert.equal((await Member.findById(legacy._id)).memberCode, first.memberCode);
    assert.equal((await MemberCounter.findById(gym)).value, 507);
    const duplicate = { ...values, memberNumber: first.memberNumber, memberCode: first.memberCode };
    await assert.rejects(Member.create(duplicate), (error) => error.code === 11000);
  });
});

describe('Member renewals and history', { concurrency: false }, () => {
  it('calculates calendar months across month ends, leap years, and year boundaries', () => {
    assert.equal(monthExpiry('2026-01-01', 1), '2026-01-31');
    assert.equal(monthExpiry('2026-01-15', 1), '2026-02-14');
    assert.equal(monthExpiry('2026-01-31', 1), '2026-02-28');
    assert.equal(monthExpiry('2028-01-31', 1), '2028-02-29');
    assert.equal(monthExpiry('2028-02-29', 12), '2029-02-28');
    assert.equal(monthExpiry('2026-12-01', 12), '2027-11-30');
    assert.equal(planMonths({ durationDays: 90 }), 3);
    assert.equal(planMonths({ durationDays: 365 }), 12);
  });
  it('blocks early same-plan renewal without changing validity or history', async () => {
    await request(`/member-plans/${plan.id}`, admin, 'PATCH', { price: '700', durationMonths: 2 });
    const original = member.membership;
    const count = await MemberHistory.countDocuments({ member: member.id });
    const result = await request(`/members/${member.id}/renew`, admin, 'POST', { revision: member.revision });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /already active or scheduled/);
    assert.equal((await request(`/members/${member.id}/renew`, admin, 'POST', { revision: member.revision, planId: String(plan.id).toUpperCase() })).status, 409);
    const stored = await Member.findById(member.id);
    assert.equal(stored.membership.expiresOn, original.expiresOn);
    assert.equal(stored.membership.pricePaise, original.pricePaise);
    assert.equal(stored.revision, member.revision);
    assert.equal(await MemberHistory.countDocuments({ member: member.id }), count);
  });
  it('blocks same-plan renewal on the expiry day and before a scheduled start', async () => {
    for (const [index, start] of [todayInIndia(), addDays(todayInIndia(), 5)].entries()) {
      const response = await request('/members', admin, 'POST', { ...memberValues(`renewal-boundary-${index}`), startsOn: start });
      assert.equal(response.status, 201);
      if (index === 0) await Member.updateOne({ _id: response.body.data.id }, { $set: { 'membership.expiresOn': todayInIndia() } });
      assert.equal((await request(`/members/${response.body.data.id}/renew`, admin, 'POST', { revision: 0 })).status, 409);
    }
  });
  it('allows one renewal after expiry and rejects duplicate or stale requests', async () => {
    assert.equal((await request(`/members/${member.id}/renew`, admin, 'POST', { revision: 0 })).status, 409);
    await Member.updateOne({ _id: member.id }, { $set: { 'membership.startsOn': addDays(todayInIndia(), -100), 'membership.expiresOn': addDays(todayInIndia(), -1) } });
    const results = await Promise.all([1, 2].map(() => request(`/members/${member.id}/renew`, admin, 'POST', { revision: member.revision })));
    assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
    member = results.find((item) => item.status === 200).body.data;
    assert.equal(member.membership.startsOn, todayInIndia());
    assert.equal(member.membership.expiresOn, monthExpiry(todayInIndia(), 2));
    assert.equal(member.membership.pricePaise, 70000);
    const history = (await request(`/members/${member.id}/history`, admin)).body.data;
    assert.equal(history.length, 2);
    assert.equal(history[0].status, 'Active');
    assert.equal(history[1].status, 'Closed');
    assert.equal(history[1].membership.pricePaise, 50025);
    assert.equal(history[0].previousMembership.pricePaise, 50025);
    assert.equal((await request(`/members/${member.id}/renew`, admin, 'POST', { revision: member.revision })).status, 409);
  });
  it('restarts expired memberships today with inclusive expiry dates', async () => {
    const oldDate = addDays(todayInIndia(), -120);
    const expired = await request('/members', admin, 'POST', { ...memberValues('expired'), joinedOn: oldDate, startsOn: oldDate });
    assert.equal(expired.status, 201);
    assert.equal(expired.body.data.status, 'Expired');
    const renewed = await request(`/members/${expired.body.data.id}/renew`, admin, 'POST', { revision: 0 });
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.data.status, 'Active');
    assert.equal(renewed.body.data.membership.startsOn, todayInIndia());
    assert.equal(renewed.body.data.membership.expiresOn, monthExpiry(todayInIndia(), 2));
  });
  it('rolls back replacement and automatic closure if history cannot be saved', async (t) => {
    const before = (await Member.findById(member.id)).toObject();
    const replacement = (await request('/member-plans', admin, 'POST', { ...planValues(), name: 'Rollback Replacement', code: 'ROLLBACK' })).body.data;
    const historyBefore = await MemberHistory.find({ member: member.id }).sort({ _id: 1 }).lean();
    t.mock.method(MemberHistory, 'create', async () => { throw new Error('Simulated history failure'); });
    assert.equal((await request(`/members/${member.id}/renew`, admin, 'POST', { revision: member.revision, planId: replacement.id })).status, 500);
    const after = (await Member.findById(member.id)).toObject();
    assert.deepEqual(after.membership, before.membership); assert.equal(after.revision, before.revision);
    assert.deepEqual(await MemberHistory.find({ member: member.id }).sort({ _id: 1 }).lean(), historyBefore);
    t.mock.restoreAll();
  });
  it('changes plan from today, using only another plan within the same gym', async () => {
    assert.equal((await request(`/members/${member.id}/renew`, admin, 'POST', { revision: member.revision, planId: otherPlan.id })).status, 400);
    const alternate = (await request('/member-plans', admin, 'POST', { ...planValues(), name: 'Quarterly', code: 'QUARTER', durationMonths: 3 })).body.data;
    const response = await request(`/members/${member.id}/renew`, admin, 'POST', { revision: member.revision, planId: alternate.id });
    assert.equal(response.status, 200); member = response.body.data;
    assert.equal(member.membership.startsOn, todayInIndia()); assert.equal(member.membership.expiresOn, monthExpiry(todayInIndia(), 3));
    const history = (await request(`/members/${member.id}/history`, admin)).body.data;
    assert.equal(history[0].action, 'Changed');
    assert.equal(history[0].status, 'Active');
    assert.equal(history.filter((item) => item.status === 'Active').length, 1);
    assert.equal(history[1].status, 'Closed');
    assert.equal(history[1].closedOn, todayInIndia());
    assert.equal(history[1].closureReason, 'Replaced');
  });
  it('archives member plans without changing existing membership snapshots', async () => {
    const snapshot = member.membership;
    assert.equal((await request(`/member-plans/${snapshot.planId}`, admin, 'DELETE')).status, 200);
    assert.equal((await request('/member-plans', admin)).body.data.some((item) => item.id === snapshot.planId), false);
    assert.equal((await request(`/members/${member.id}/renew`, admin, 'POST', { revision: member.revision })).status, 400);
    assert.equal((await request(`/member-plans/${snapshot.planId}`, admin, 'PATCH', { isActive: true })).status, 404);
    const listed = (await request(`/members?search=${encodeURIComponent(member.email)}`, admin)).body.data.find((item) => item.id === member.id);
    assert.deepEqual(listed.membership, snapshot);
  });
  it('requires gym-admin scope and a current revision for deletion', async () => {
    const self = (await signIn(member.email)).accessToken;
    assert.equal((await request(`/members/${member.id}`, null, 'DELETE', { revision: member.revision })).status, 401);
    for (const token of [trainerLogin, self, superadmin]) assert.equal((await request(`/members/${member.id}`, token, 'DELETE', { revision: member.revision })).status, 403);
    assert.equal((await request(`/members/${member.id}`, otherAdmin, 'DELETE', { revision: member.revision })).status, 404);
    assert.equal((await request(`/members/${member.id}`, admin, 'DELETE', {})).status, 400);
    assert.equal((await request(`/members/${member.id}`, admin, 'DELETE', { revision: 0 })).status, 409);
  });
  it('rolls back deletion and login changes if session revocation fails', async (t) => {
    t.mock.method(Session, 'deleteMany', () => { throw new Error('Simulated session failure'); });
    assert.equal((await request(`/members/${member.id}`, admin, 'DELETE', { revision: member.revision })).status, 500);
    const stored = await Member.findById(member.id);
    assert.equal(stored.deletedAt, null);
    assert.equal(stored.isActive, true);
    assert.equal((await User.findById(stored.user)).isActive, true);
    t.mock.restoreAll();
  });
  it('deletes from the directory, revokes login, and retains membership history', async () => {
    const self = (await signIn(member.email)).accessToken;
    const count = await MemberHistory.countDocuments({ member: member.id });
    assert.equal((await request(`/members/${member.id}`, admin, 'DELETE', { revision: member.revision })).status, 200);
    assert.ok((await Member.findById(member.id)).deletedAt);
    assert.equal((await request('/members', admin)).body.data.some((item) => item.id === member.id), false);
    assert.equal((await request('/members', trainerLogin)).body.data.some((item) => item.id === member.id), false);
    assert.equal((await request('/members', self)).status, 401);
    assert.equal((await request('/auth/login', null, 'POST', { email: member.email, password: secret })).status, 403);
    assert.equal((await request(`/members/${member.id}`, admin, 'PATCH', profile(member))).status, 404);
    assert.equal((await request(`/members/${member.id}/renew`, admin, 'POST', { revision: member.revision })).status, 404);
    assert.equal(await MemberHistory.countDocuments({ member: member.id }), count);
  });
  it('revokes inactive trainers and clears assignments without losing members', async () => {
    assert.equal((await request(`/trainers/${trainer.id}`, admin, 'PATCH', { isActive: false })).status, 200);
    assert.equal((await request('/members', trainerLogin)).status, 401);
    assert.equal((await request('/auth/login', null, 'POST', { email: trainer.email, password: secret })).status, 403);
    assert.equal(await Member.countDocuments({ trainer: trainer.id }), 0);
    assert.ok(await Member.countDocuments({ gym }));
    assert.equal((await request('/members', admin, 'POST', memberValues('inactive-trainer'))).status, 400);
  });
});

describe('Live member dashboard summaries', { concurrency: false }, () => {
  let dashboardMember, dashboardTrainer, dashboardMemberToken, dashboardTrainerToken;
  before(async () => {
    dashboardTrainer = await User.findOne({ gym, email: 'id-trainer@example.test' });
    dashboardTrainerToken = (await signIn(dashboardTrainer.email)).accessToken;
    const created = await request('/members', admin, 'POST', { ...memberValues('dashboard-self'), trainerId: String(dashboardTrainer._id), email: 'dashboard-member@example.test', createLogin: true, password: secret });
    assert.equal(created.status, 201); dashboardMember = created.body.data;
    dashboardMemberToken = (await signIn(dashboardMember.email)).accessToken;
    const membership = (await Member.findById(dashboardMember.id)).membership.toObject();
    await Member.create([
      { gym, name: 'Due today', phone: '9876543210', joinedOn: todayInIndia(), membership: { ...membership, expiresOn: todayInIndia() } },
      { gym, name: 'Due in seven days', phone: '9876543210', joinedOn: todayInIndia(), membership: { ...membership, expiresOn: addDays(todayInIndia(), 7) } },
      { gym, name: 'Due in eight days', phone: '9876543210', joinedOn: todayInIndia(), membership: { ...membership, expiresOn: addDays(todayInIndia(), 8) } },
      { gym, name: 'Inactive near expiry', phone: '9876543210', joinedOn: todayInIndia(), isActive: false, membership: { ...membership, expiresOn: todayInIndia() } },
      { gym, name: 'Future member', phone: '9876543210', joinedOn: todayInIndia(), membership: { ...membership, startsOn: addDays(todayInIndia(), 1), expiresOn: addDays(todayInIndia(), 20) } },
    ]);
  });
  it('returns live gym counts, renewal windows, six-month history, and bounded member lists', async () => {
    const response = await request('/dashboard/summary', admin);
    assert.equal(response.status, 200);
    const data = response.body.data;
    const all = await Member.find({ gym, deletedAt: null });
    const active = all.filter((item) => item.isActive && item.membership.startsOn <= todayInIndia() && item.membership.expiresOn >= todayInIndia());
    assert.equal(data.totalMembers, all.length);
    assert.equal(data.activeMembers, active.length);
    assert.equal(data.totalMembers, data.activeMembers + data.expiredMembers + data.upcomingMembers + data.inactiveMembers);
    assert.equal(data.expiringSoon, active.filter((item) => item.membership.expiresOn <= addDays(todayInIndia(), 7)).length);
    assert.ok(data.upcomingRenewals.some((item) => item.name === 'Due today'));
    assert.ok(data.upcomingRenewals.some((item) => item.name === 'Due in seven days'));
    assert.equal(data.upcomingRenewals.some((item) => item.name === 'Due in eight days' || item.name === 'Inactive near expiry'), false);
    assert.ok(data.recentMembers.length <= 5);
    assert.equal(data.growth.length, 6);
    assert.equal(data.growth.at(-1).month, todayInIndia().slice(0, 7));
    assert.equal(data.growth.at(-1).count, all.filter((item) => item.joinedOn.startsWith(todayInIndia().slice(0, 7)) && item.joinedOn <= todayInIndia()).length);
    assert.equal(data.activeTrainers, await User.countDocuments({ gym, role: 'TRAINER', isActive: { $ne: false } }));
    const allowed = new Set(all.map((item) => String(item._id)));
    for (const item of [...data.recentMembers, ...data.upcomingRenewals]) assert.ok(allowed.has(item.id));
  });
  it('limits summaries to the assigned trainer or own member profile', async () => {
    for (const token of [dashboardTrainerToken, dashboardMemberToken]) {
      const result = await request('/dashboard/summary', token);
      assert.equal(result.status, 200);
      assert.equal(result.body.data.totalMembers, 1);
      assert.equal(result.body.data.recentMembers[0].id, dashboardMember.id);
      assert.equal(result.body.data.activeTrainers, null);
    }
    assert.equal((await request('/dashboard/summary', null)).status, 401);
    assert.equal((await request('/dashboard/summary', superadmin)).status, 403);
  });
  it('returns an honest empty state for a gym with no members', async () => {
    const id = new mongoose.Types.ObjectId();
    const account = await User.create({ name: 'Empty Gym Admin', email: 'empty-admin@example.test', gym: id, role: 'GYMADMIN', passwordHash: await bcrypt.hash(secret, 4) });
    await Gym.create({ _id: id, name: 'Empty Gym', email: 'empty@example.test', phone: '9876543210', admin: account._id, createdBy: account._id });
    const token = (await signIn(account.email)).accessToken;
    const result = await request('/dashboard/summary', token);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.totalMembers, 0);
    assert.equal(result.body.data.activeMembers, 0);
    assert.equal(result.body.data.expiringSoon, 0);
    assert.deepEqual(result.body.data.recentMembers, []);
    assert.deepEqual(result.body.data.upcomingRenewals, []);
    assert.ok(result.body.data.growth.every((item) => item.count === 0));
  });
});

