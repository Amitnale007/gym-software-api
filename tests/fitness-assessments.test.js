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
import Member from '../models/memberModel.js';
import MemberPlan from '../models/memberPlanModel.js';
import FitnessAssessment from '../models/fitnessAssessmentModel.js';
import { calculateBmi, fitnessValues } from '../utils/fitness.js';
import { addDays, todayInIndia } from '../utils/subscription.js';

let database, server, base, gym, otherGym, member, anotherMember, foreignMember, trainer, assessment;
const tokens = {};
const today = todayInIndia();
const sample = (extra = {}) => ({ assessedOn: today, heightCm: 175, weightKg: 75, bodyFatPercent: 20, bodyFatMethod: 'bioimpedance', chestCm: 98, waistCm: 85, leftArmCm: 32, rightArmCm: 33, leftThighCm: 55, rightThighCm: 56, notes: 'Good progress', goals: 'Improve strength', ...extra });
async function request(path, actor = 'admin', method = 'GET', body) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(tokens[actor] ? { Authorization: `Bearer ${tokens[actor]}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
const endpoint = () => `/members/${member._id}/fitness-assessments`;

before(async () => {
  process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
  process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri(), { dbName: 'fitness-assessment-tests' });
  gym = new mongoose.Types.ObjectId(); otherGym = new mongoose.Types.ObjectId();
  const passwordHash = await bcrypt.hash('FitnessTest123!', 4);
  const accounts = await User.create([
    { name: 'Gym admin', email: 'fitness-admin@example.test', role: 'GYMADMIN', gym, passwordHash },
    { name: 'Other admin', email: 'fitness-other-admin@example.test', role: 'GYMADMIN', gym: otherGym, passwordHash },
    { name: 'Assigned trainer', email: 'fitness-trainer@example.test', role: 'TRAINER', gym, passwordHash },
    { name: 'Unassigned trainer', email: 'fitness-unassigned@example.test', role: 'TRAINER', gym, passwordHash },
    { name: 'Own member', email: 'fitness-member@example.test', role: 'MEMBER', gym, passwordHash },
    { name: 'Other member', email: 'fitness-other-member@example.test', role: 'MEMBER', gym, passwordHash },
    { name: 'Root', email: 'fitness-root@example.test', role: 'SUPERADMIN', passwordHash },
  ]);
  trainer = accounts[2];
  await Gym.create([
    { _id: gym, name: 'Fitness gym', email: 'fitness-gym@example.test', phone: '9876543210', admin: accounts[0]._id, createdBy: accounts[6]._id },
    { _id: otherGym, name: 'Other gym', email: 'fitness-other-gym@example.test', phone: '9876543211', admin: accounts[1]._id, createdBy: accounts[6]._id },
  ]);
  const plan = await MemberPlan.create({ gym, name: 'Fitness plan', nameKey: 'fitness plan', code: 'FITNESS', pricePaise: 50000, durationMonths: 1, trainerIncluded: true });
  const membership = { plan: plan._id, planName: plan.name, pricePaise: 50000, durationMonths: 1, trainerIncluded: true, startsOn: today, expiresOn: addDays(today, 30) };
  [member, anotherMember, foreignMember] = await Member.create([
    { gym, name: 'Fitness member', memberNumber: 1, memberCode: 'MEM0001', phone: '9876543210', joinedOn: today, trainer: trainer._id, user: accounts[4]._id, membership },
    { gym, name: 'Other member', memberNumber: 2, memberCode: 'MEM0002', phone: '9876543211', joinedOn: today, user: accounts[5]._id, membership },
    { gym: otherGym, name: 'Foreign member', memberNumber: 1, memberCode: 'MEM0001', phone: '9876543212', joinedOn: today, membership },
  ]);
  await FitnessAssessment.init();
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  for (const [index, actor] of ['admin', 'otherAdmin', 'trainer', 'unassigned', 'member', 'otherMember', 'root'].entries()) {
    const response = await request('/auth/login', 'none', 'POST', { email: accounts[index].email, password: 'FitnessTest123!' });
    assert.equal(response.status, 200); tokens[actor] = response.body.data.accessToken;
  }
}, { timeout: 120_000 });
after(async () => { if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } await mongoose.disconnect(); if (database) await database.stop(); });

describe('Member fitness tracking', { concurrency: false }, () => {
  it('calculates BMI and rejects missing or non-finite inputs', () => {
    assert.equal(calculateBmi(175, 75), 24.5);
    assert.equal(calculateBmi(180, 81), 25);
    for (const [height, weight] of [[0, 75], [175, 0], [Infinity, 75], [175, NaN], [null, 75]]) assert.equal(calculateBmi(height, weight), null);
    assert.throws(() => fitnessValues(sample({ weightKg: Infinity })), /Weight/);
  });
  it('starts with an empty summary and paginated history', async () => {
    const summary = await request(`${endpoint()}/summary`);
    assert.equal(summary.status, 200); assert.deepEqual(summary.body.data, { latest: null, previous: null, trend: [] });
    const history = await request(endpoint());
    assert.equal(history.status, 200); assert.deepEqual(history.body.data, []); assert.equal(history.body.meta.pagination.total, 0);
  });
  it('allows an assigned trainer to record measurements and calculates BMI on the server', async () => {
    const result = await request(endpoint(), 'trainer', 'POST', sample({ bmi: 1, gym: String(otherGym), member: String(foreignMember._id), recordedBy: { id: 'fake', name: 'Fake' }, corrections: [{ reason: 'fake' }] }));
    assert.equal(result.status, 201); assessment = result.body.data;
    assert.equal(assessment.bmi, 24.5); assert.equal(assessment.leftArmCm, 32); assert.equal(assessment.rightArmCm, 33);
    assert.equal(assessment.recordedBy.id, String(trainer._id)); assert.deepEqual(assessment.corrections, []); assert.equal(assessment.revision, 0);
    const stored = await FitnessAssessment.findById(assessment.id);
    assert.equal(String(stored.gym), String(gym)); assert.equal(String(stored.member), String(member._id));
  });
  it('accepts height and weight alone without fabricating optional measurements', async () => {
    const result = await request(endpoint(), 'admin', 'POST', { assessedOn: addDays(today, -10), heightCm: 175, weightKg: 78 });
    assert.equal(result.status, 201); assert.equal(result.body.data.bmi, 25.5);
    for (const field of ['bodyFatPercent', 'chestCm', 'waistCm', 'leftArmCm', 'rightArmCm', 'leftThighCm', 'rightThighCm']) assert.equal(result.body.data[field], null);
    assert.equal(result.body.data.bodyFatMethod, '');
  });
  it('validates dates, measurement ranges, numeric types, method and note lengths', async () => {
    const count = await FitnessAssessment.countDocuments();
    for (const invalid of [
      { heightCm: 0 }, { heightCm: '175' }, { heightCm: null }, { heightCm: 301 }, { weightKg: -1 }, { weightKg: 701 },
      { bodyFatPercent: 0 }, { bodyFatPercent: 100 }, { bodyFatMethod: '' }, { bodyFatMethod: 'formula' }, { bodyFatPercent: null },
      { leftArmCm: -1 }, { rightThighCm: 301 }, { waistCm: {} }, { assessedOn: '2026-02-30' }, { assessedOn: addDays(today, 1) },
      { notes: 'x'.repeat(1001) }, { goals: 'x'.repeat(501) }, { notes: { $ne: '' } },
    ]) assert.equal((await request(endpoint(), 'admin', 'POST', sample(invalid))).status, 400, JSON.stringify(invalid));
    assert.equal(await FitnessAssessment.countDocuments(), count);
  });
  it('limits reads to gym admins, assigned trainers and the linked member', async () => {
    for (const suffix of ['', '/summary']) {
      for (const actor of ['admin', 'trainer', 'member']) assert.equal((await request(`${endpoint()}${suffix}`, actor)).status, 200);
      for (const actor of ['otherAdmin', 'unassigned', 'otherMember']) assert.equal((await request(`${endpoint()}${suffix}`, actor)).status, 404);
      assert.equal((await request(`${endpoint()}${suffix}`, 'none')).status, 401);
      assert.equal((await request(`${endpoint()}${suffix}`, 'root')).status, 403);
    }
  });
  it('blocks member writes, unassigned trainers, foreign gyms, and cross-member corrections', async () => {
    for (const actor of ['member', 'otherMember', 'root']) {
      assert.equal((await request(endpoint(), actor, 'POST', sample())).status, 403);
      assert.equal((await request(`${endpoint()}/${assessment.id}`, actor, 'PATCH', sample({ revision: 0, correctionReason: 'Fix reading' }))).status, 403);
    }
    for (const actor of ['otherAdmin', 'unassigned']) {
      assert.equal((await request(endpoint(), actor, 'POST', sample())).status, 404);
      assert.equal((await request(`${endpoint()}/${assessment.id}`, actor, 'PATCH', sample({ revision: 0, correctionReason: 'Fix reading' }))).status, 404);
    }
    assert.equal((await request(`/members/${anotherMember._id}/fitness-assessments/${assessment.id}`, 'admin', 'PATCH', sample({ revision: 0, correctionReason: 'Wrong member' }))).status, 404);
    assert.equal((await request(`/members/${foreignMember._id}/fitness-assessments`, 'admin', 'POST', sample())).status, 404);
  });
  it('requires a revision and reason and retains the old values when correcting', async () => {
    for (const extra of [{}, { revision: 0 }, { revision: -1, correctionReason: 'Fix' }, { revision: 0, correctionReason: ' ' }]) assert.equal((await request(`${endpoint()}/${assessment.id}`, 'admin', 'PATCH', sample(extra))).status, 400);
    const corrected = await request(`${endpoint()}/${assessment.id}`, 'admin', 'PATCH', sample({ revision: 0, correctionReason: 'Scale reading corrected', weightKg: 74, waistCm: null, notes: 'Corrected note' }));
    assert.equal(corrected.status, 200); assessment = corrected.body.data;
    assert.equal(assessment.revision, 1); assert.equal(assessment.bmi, 24.2); assert.equal(assessment.waistCm, null);
    assert.equal(assessment.corrections[0].previous.weightKg, 75); assert.equal(assessment.corrections[0].previous.waistCm, 85);
    assert.equal(assessment.corrections[0].reason, 'Scale reading corrected'); assert.equal(assessment.corrections[0].correctedBy.name, 'Gym admin');
    assert.equal(assessment.recordedBy.name, 'Assigned trainer');
  });
  it('rejects stale corrections and allows only one concurrent update', async () => {
    assert.equal((await request(`${endpoint()}/${assessment.id}`, 'trainer', 'PATCH', sample({ revision: 0, correctionReason: 'Stale update' }))).status, 409);
    const results = await Promise.all([73, 72].map((weightKg) => request(`${endpoint()}/${assessment.id}`, 'trainer', 'PATCH', sample({ revision: 1, weightKg, correctionReason: 'Rechecked reading' }))));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assessment = results.find((result) => result.status === 200).body.data;
    assert.equal(assessment.revision, 2); assert.equal(assessment.corrections.length, 2);
    assert.equal(assessment.corrections[1].previous.weightKg, 74);
  });
  it('uses assessment date for latest/previous, paginates history, and limits chart data', async () => {
    await FitnessAssessment.insertMany(Array.from({ length: 105 }, (_, index) => ({
      gym, member: member._id, ...fitnessValues(sample({ assessedOn: addDays(today, -index - 20), weightKg: 80 + index / 10 })), recordedBy: { id: trainer._id, name: trainer.name },
    })));
    const summary = await request(`${endpoint()}/summary`);
    assert.equal(summary.body.data.latest.id, assessment.id);
    assert.equal(summary.body.data.previous.assessedOn, addDays(today, -10)); assert.equal(summary.body.data.trend.length, 100);
    assert.equal(summary.body.data.trend.at(-1).id, assessment.id); assert.equal(summary.body.data.latest.corrections, undefined);
    const history = await request(`${endpoint()}?pageSize=5&page=2`);
    assert.equal(history.body.data.length, 5); assert.equal(history.body.meta.pagination.total, 107); assert.equal(history.body.meta.pagination.pageNumber, 2);
    const clamped = await request(`${endpoint()}?pageSize=5&page=999`);
    assert.equal(clamped.body.meta.pagination.pageNumber, 22); assert.equal(clamped.body.data.length, 2);
    assert.equal((await request(`/members/not-an-id/fitness-assessments`)).status, 400);
  });
  it('revokes trainer access immediately after reassignment', async () => {
    await Member.updateOne({ _id: member._id }, { $set: { trainer: null } });
    assert.equal((await request(endpoint(), 'trainer')).status, 404);
    assert.equal((await request(endpoint(), 'trainer', 'POST', sample())).status, 404);
    assert.equal((await request(`${endpoint()}/${assessment.id}`, 'trainer', 'PATCH', sample({ revision: 2, correctionReason: 'No longer assigned' }))).status, 404);
    assert.equal((await request(endpoint(), 'member')).status, 200);
  });
  it('retains records after member removal while hiding all fitness endpoints', async () => {
    await Member.updateOne({ _id: member._id }, { $set: { deletedAt: new Date() } });
    assert.equal((await request(endpoint())).status, 404);
    assert.equal((await request(`${endpoint()}/summary`)).status, 404);
    assert.equal((await request(endpoint(), 'admin', 'POST', sample())).status, 404);
    assert.equal(await FitnessAssessment.countDocuments({ member: member._id }), 107);
  });
});
