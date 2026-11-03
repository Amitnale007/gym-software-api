import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '../app.js';
import User from '../models/userModel.js';
import Gym from '../models/gymModel.js';
import Session from '../models/sessionModel.js';
import seedSuperadmin from '../services/seedSuperadmin.js';
import { validateAuthConfig, JWT_OPTIONS } from '../config/auth.js';
import Plan from '../models/subscriptionPlanModel.js';
import History from '../models/subscriptionHistoryModel.js';
import { addDays, publicPlan, publicSubscription, subscriptionSnapshot, todayInIndia } from '../utils/subscription.js';

let database, server, base, superadmin, gymadmin, gym, plan;
const credentials = { email: 'superadmin@example.test', password: 'TestAdmin123!' };
const gymValues = (suffix = 'one') => ({
  name: `Test Gym ${suffix}`, email: `contact-${suffix}@example.test`, phone: '+91 9876543210',
  address: '123 Test Street', city: 'Pune', adminName: `Gymadmin ${suffix}`,
  adminEmail: `admin-${suffix}@example.test`, adminPassword: 'GymAdmin123!',
  planId: plan?.id, startsOn: todayInIndia(),
});

async function request(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
async function signIn(email, password) {
  const result = await request('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.status, 200);
  return result.body.data;
}

before(async () => {
  process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
  process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
  process.env.JWT_ACCESS_EXPIRES_IN = '15m';
  process.env.JWT_REFRESH_EXPIRES_IN = '7d';
  validateAuthConfig();
  // A disposable replica set exercises real MongoDB transactions, never the user's Atlas DB.
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri(), { dbName: 'gym-integration-tests' });
  await Promise.all([User.init(), Gym.init(), Session.init(), Plan.init(), History.init()]);
  plan = await Plan.create({ name: 'Monthly', nameKey: 'monthly', pricePaise: 99900, durationDays: 30 });
  await seedSuperadmin(credentials);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120_000 });

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await mongoose.disconnect();
  if (database) await database.stop();
});

describe('MongoDB authentication and gym onboarding', { concurrency: false }, () => {
  it('seeds one Superadmin with explicit input and preserves its database password', async () => {
    await seedSuperadmin({ ...credentials, password: 'AnotherPassword123!' });
    const users = await User.find({ email: credentials.email }).select('+passwordHash');
    assert.equal(users.length, 1);
    assert.equal(users[0].role, 'SUPERADMIN');
    assert.ok(await bcrypt.compare(credentials.password, users[0].passwordHash));
    assert.notEqual(users[0].passwordHash, credentials.password);
  });

  it('logs in using only the database account when no bootstrap input is configured', async () => {
    const session = await signIn(credentials.email, credentials.password);
    assert.equal(session.user.role, 'SUPERADMIN');
  });

  it('rejects missing setup input and weak initial passwords', async () => {
    await assert.rejects(seedSuperadmin(), /Email/);
    await assert.rejects(seedSuperadmin({ email: 'weak@example.test', password: 'short' }), /Password/);
    assert.equal(await User.countDocuments({ email: 'weak@example.test' }), 0);
  });

  it('rejects unauthenticated gym and user access', async () => {
    for (const path of ['/gyms', '/users', '/auth/me']) assert.equal((await request(path)).status, 401);
    assert.equal((await request('/gyms', { method: 'POST', body: gymValues() })).status, 401);
    assert.equal((await request('/users', { method: 'POST', body: { role: 'SUPERADMIN' } })).status, 401);
  });

  it('rejects wrong credentials and operator injection, then logs in from MongoDB', async () => {
    assert.equal((await request('/auth/login', { method: 'POST', body: { ...credentials, password: 'wrong' } })).status, 401);
    assert.equal((await request('/auth/login', { method: 'POST', body: { email: { $ne: null }, password: 'wrong' } })).status, 400);
    superadmin = await signIn(credentials.email.toUpperCase(), credentials.password);
    assert.equal(superadmin.user.role, 'SUPERADMIN');
    assert.equal(superadmin.user.passwordHash, undefined);
    assert.equal(jwt.decode(superadmin.accessToken).exp - jwt.decode(superadmin.accessToken).iat, 900);
    assert.equal(jwt.decode(superadmin.refreshToken).exp - jwt.decode(superadmin.refreshToken).iat, 604800);
    const stored = await Session.findOne().select('+refreshHash');
    assert.notEqual(stored.refreshHash, superadmin.refreshToken);
  });

  it('validates gym details and does not save a partial gym or admin', async () => {
    const result = await request('/gyms', { method: 'POST', token: superadmin.accessToken, body: { ...gymValues(), adminPassword: 'short' } });
    assert.equal(result.status, 400);
    assert.equal(await Gym.countDocuments(), 0);
    assert.equal(await User.countDocuments({ role: 'GYMADMIN' }), 0);
  });

  it('saves a gym and Gymadmin together and exposes no password fields', async () => {
    const result = await request('/gyms', { method: 'POST', token: superadmin.accessToken, body: { ...gymValues(), role: 'SUPERADMIN' } });
    assert.equal(result.status, 201);
    gym = result.body.data;
    assert.equal(gym.admin.role, 'GYMADMIN');
    assert.equal(gym.admin.gymId, gym.id);
    assert.equal(gym.admin.passwordHash, undefined);
    const admin = await User.findById(gym.admin.id).select('+passwordHash');
    assert.ok(await bcrypt.compare(gymValues().adminPassword, admin.passwordHash));
    assert.equal((await request('/gyms', { token: superadmin.accessToken })).body.data.length, 1);
  });

  it('rejects a duplicate administrator email without creating another gym', async () => {
    const result = await request('/gyms', { method: 'POST', token: superadmin.accessToken, body: gymValues() });
    assert.equal(result.status, 409);
    assert.equal(await Gym.countDocuments(), 1);
    assert.equal(await User.countDocuments({ role: 'GYMADMIN' }), 1);
  });

  it('rolls back the administrator if saving the gym fails', async (t) => {
    const before = await User.countDocuments();
    const original = Gym.create;
    t.mock.method(Gym, 'create', async () => { throw new Error('Simulated gym write failure'); });
    try {
      assert.equal((await request('/gyms', { method: 'POST', token: superadmin.accessToken, body: gymValues('rollback') })).status, 500);
      assert.equal(await User.countDocuments(), before);
      assert.equal(await Gym.countDocuments(), 1);
    } finally { Gym.create = original; }
  });

  it('lets Gymadmin sign in and view only their gym, blocking Superadmin operations', async () => {
    gymadmin = await signIn(gymValues().adminEmail, gymValues().adminPassword);
    assert.equal((await request('/gyms/mine', { token: gymadmin.accessToken })).body.data.id, gym.id);
    assert.equal((await request('/gyms', { token: gymadmin.accessToken })).status, 403);
    assert.equal((await request('/gyms', { method: 'POST', token: gymadmin.accessToken, body: gymValues('forbidden') })).status, 403);
  });

  it('forces customer accounts into the signed-in Gymadmin gym and isolates other gyms', async () => {
    const secondGym = await request('/gyms', { method: 'POST', token: superadmin.accessToken, body: gymValues('two') });
    assert.equal(secondGym.status, 201);
    const customerResult = await request('/users', { method: 'POST', token: gymadmin.accessToken, body: {
      name: 'Test Customer', email: 'customer@example.test', password: 'Customer123!', role: 'SUPERADMIN', gym: secondGym.body.data.id,
    } });
    assert.equal(customerResult.status, 201);
    assert.equal(customerResult.body.data.role, 'MEMBER');
    assert.equal(customerResult.body.data.gymId, gym.id);
    const users = await request('/users', { token: gymadmin.accessToken });
    assert.ok(users.body.data.every((user) => user.gymId === gym.id));
    assert.equal(users.body.data.length, 2);
    const customer = await signIn('customer@example.test', 'Customer123!');
    assert.equal((await request('/gyms/mine', { token: customer.accessToken })).body.data.id, gym.id);
    for (const path of ['/gyms', '/users']) assert.equal((await request(path, { token: customer.accessToken })).status, 403);
    assert.equal((await request('/users', { method: 'POST', token: customer.accessToken, body: { name: 'Forbidden' } })).status, 403);
  });

  it('rejects forged, expired, and wrong-type JWTs', async () => {
    const claims = jwt.decode(superadmin.accessToken);
    const expired = jwt.sign({ sub: claims.sub, sid: claims.sid, type: 'access' }, process.env.JWT_ACCESS_SECRET, { ...JWT_OPTIONS, expiresIn: -1 });
    for (const token of ['invalid', expired, superadmin.refreshToken]) {
      assert.equal((await request('/gyms', { token })).status, 401);
    }
    assert.equal((await request('/auth/refresh-token', { method: 'POST', body: { refreshToken: superadmin.accessToken } })).status, 401);
  });

  it('rotates refresh tokens and rejects reuse', async () => {
    const previous = superadmin.refreshToken;
    const result = await request('/auth/refresh-token', { method: 'POST', body: { refreshToken: previous } });
    assert.equal(result.status, 200);
    assert.notEqual(result.body.data.refreshToken, previous);
    assert.equal((await request('/auth/refresh-token', { method: 'POST', body: { refreshToken: previous } })).status, 401);
    superadmin = result.body.data;
  });

  it('allows only one concurrent refresh with the same token', async () => {
    const results = await Promise.all([1, 2].map(() => request('/auth/refresh-token', { method: 'POST', body: { refreshToken: superadmin.refreshToken } })));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 401]);
    superadmin = results.find((result) => result.status === 200).body.data;
  });

  it('revokes both access and refresh tokens on logout', async () => {
    assert.equal((await request('/auth/logout', { method: 'POST', token: superadmin.accessToken })).status, 200);
    assert.equal((await request('/gyms', { token: superadmin.accessToken })).status, 401);
    assert.equal((await request('/auth/refresh-token', { method: 'POST', body: { refreshToken: superadmin.refreshToken } })).status, 401);
  });

  it('blocks login and existing sessions when a gym is inactive', async () => {
    await Gym.updateOne({ _id: gym.id }, { status: 'Inactive' });
    assert.equal((await request('/gyms/mine', { token: gymadmin.accessToken })).status, 403);
    assert.equal((await request('/auth/login', { method: 'POST', body: { email: gymValues().adminEmail, password: gymValues().adminPassword } })).status, 403);
  });
});

describe('Subscription master and gym subscriptions', { concurrency: false }, () => {
  let alternative, newGym;
  const change = (body, id = gym.id) => request(`/gyms/${id}/subscription`, { method: 'PATCH', token: superadmin.accessToken, body });
  const getGym = async (id = gym.id) => (await request('/gyms', { token: superadmin.accessToken })).body.data.find((item) => item.id === id);
  const getHistory = async (id = gym.id) => (await request(`/gyms/${id}/subscription/history`, { token: superadmin.accessToken })).body.data;

  before(async () => {
    await Gym.updateOne({ _id: gym.id }, { status: 'Active' });
    superadmin = await signIn(credentials.email, credentials.password);
  });

  it('restricts plan settings, changes, and history to Superadmin', async () => {
    assert.equal((await request('/subscription-plans')).status, 401);
    const customer = await signIn('customer@example.test', 'Customer123!');
    for (const session of [gymadmin, customer]) {
      assert.equal((await request('/subscription-plans', { token: session.accessToken })).status, 403);
      assert.equal((await request('/subscription-plans', { token: session.accessToken, method: 'POST', body: { name: 'Forbidden' } })).status, 403);
      assert.equal((await request(`/subscription-plans/${plan.id}`, { token: session.accessToken, method: 'PATCH', body: { isActive: false } })).status, 403);
      assert.equal((await request(`/gyms/${gym.id}/subscription`, { token: session.accessToken, method: 'PATCH', body: { action: 'cancel', revision: 1 } })).status, 403);
      assert.equal((await request(`/gyms/${gym.id}/subscription/history`, { token: session.accessToken })).status, 403);
    }
    const ownGym = await request('/gyms/mine', { token: customer.accessToken });
    assert.equal(ownGym.body.data.subscription.planId, plan.id);
  });

  it('rejects invalid amounts, fractional durations, and malformed plan values', async () => {
    for (const invalid of [{ price: '-1' }, { price: '1.001' }, { price: '1e3' }, { price: '10000001' }, { durationDays: 0 }, { durationDays: 1.5 }, { durationDays: 3651 }, { isActive: 'true' }, { description: {} }]) {
      const result = await request('/subscription-plans', { token: superadmin.accessToken, method: 'POST', body: { name: 'Invalid', price: '99', durationDays: 30, ...invalid } });
      assert.equal(result.status, 400, JSON.stringify(invalid));
    }
    assert.equal(await Plan.countDocuments(), 1);
  });

  it('creates a reusable master plan and prevents case-insensitive duplicate names', async () => {
    const result = await request('/subscription-plans', { token: superadmin.accessToken, method: 'POST', body: { name: 'Annual', price: '2999.99', durationDays: 365, description: 'Annual platform plan' } });
    assert.equal(result.status, 201);
    alternative = result.body.data;
    assert.equal(alternative.pricePaise, 299999);
    assert.equal(alternative.currency, 'INR');
    assert.equal(alternative.isActive, true);
    const duplicate = await request('/subscription-plans', { token: superadmin.accessToken, method: 'POST', body: { name: ' annual ', price: '0', durationDays: 1 } });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.message, /plan with this name/);
    assert.equal((await request('/subscription-plans', { token: superadmin.accessToken })).body.data.length, 2);
  });

  it('requires a valid plan and start date on gym creation without leaving partial records', async () => {
    const gymsBefore = await Gym.countDocuments();
    const usersBefore = await User.countDocuments();
    const historiesBefore = await History.countDocuments();
    for (const values of [{ planId: undefined }, { planId: 'not-an-id' }, { startsOn: '2026-02-30' }, { planId: new mongoose.Types.ObjectId().toString() }]) {
      assert.equal((await request('/gyms', { method: 'POST', token: superadmin.accessToken, body: { ...gymValues('invalid-subscription'), ...values } })).status, 400);
    }
    assert.equal(await Gym.countDocuments(), gymsBefore);
    assert.equal(await User.countDocuments(), usersBefore);
    assert.equal(await History.countDocuments(), historiesBefore);
  });

  it('saves server-calculated subscription terms and initial history with a new gym', async () => {
    const result = await request('/gyms', { method: 'POST', token: superadmin.accessToken, body: {
      ...gymValues('subscribed'), startsOn: '2026-02-01', pricePaise: 1, expiresOn: '2099-12-31',
    } });
    assert.equal(result.status, 201);
    newGym = result.body.data;
    assert.equal(newGym.subscription.expiresOn, '2026-03-02');
    assert.equal(newGym.subscription.pricePaise, 99900);
    assert.equal(newGym.subscriptionRevision, 1);
    const history = await getHistory(newGym.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].action, 'Assigned');
    assert.equal(history[0].subscription.planId, plan.id);
    assert.equal(history[0].changedBy.email, credentials.email);
  });

  it('preserves assigned terms and historical prices when the master plan changes', async () => {
    const before = await getGym();
    const result = await request(`/subscription-plans/${plan.id}`, { token: superadmin.accessToken, method: 'PATCH', body: { name: 'Monthly Plus', price: '1200.50', durationDays: 31 } });
    assert.equal(result.status, 200);
    assert.deepEqual((await getGym()).subscription, before.subscription);
    assert.equal((await getHistory())[0].subscription.pricePaise, 99900);
  });

  it('renews at current master terms without losing remaining days', async () => {
    const previous = await getGym();
    const result = await change({ action: 'renew', revision: previous.subscriptionRevision });
    assert.equal(result.status, 200);
    const updated = result.body.data;
    assert.equal(updated.subscription.startsOn, previous.subscription.startsOn);
    assert.equal(updated.subscription.expiresOn, addDays(previous.subscription.expiresOn, 31));
    assert.equal(updated.subscription.pricePaise, 120050);
    assert.equal(updated.subscription.planName, 'Monthly Plus');
    const history = await getHistory();
    assert.equal(history[0].action, 'Renewed');
    assert.equal(history[0].periodStartsOn, addDays(previous.subscription.expiresOn, 1));
    assert.equal(history[0].previousSubscription.pricePaise, 99900);
  });

  it('rejects stale updates and allows only one concurrent renewal for a revision', async () => {
    const before = await getGym();
    const results = await Promise.all([1, 2].map(() => change({ action: 'renew', revision: before.subscriptionRevision })));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const updated = await getGym();
    assert.equal(updated.subscription.expiresOn, addDays(before.subscription.expiresOn, 31));
    assert.equal(updated.subscriptionRevision, before.subscriptionRevision + 1);
    assert.equal((await change({ action: 'cancel', revision: before.subscriptionRevision })).status, 409);
  });

  it('starts expired renewals today and calculates expiry inclusively', async () => {
    const today = todayInIndia();
    await Gym.updateOne({ _id: gym.id }, { 'subscription.startsOn': addDays(today, -40), 'subscription.expiresOn': addDays(today, -1) });
    const expired = await getGym();
    assert.equal(expired.subscription.status, 'Expired');
    const result = await change({ action: 'renew', revision: expired.subscriptionRevision });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.subscription.startsOn, today);
    assert.equal(result.body.data.subscription.expiresOn, addDays(today, 30));
    assert.equal(result.body.data.subscription.status, 'Active');
  });

  it('changes the plan, calculates upcoming status, and keeps previous terms in history', async () => {
    const before = await getGym();
    const start = addDays(todayInIndia(), 1);
    const result = await change({ action: 'assign', planId: alternative.id, startsOn: start, revision: before.subscriptionRevision });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.subscription.planId, alternative.id);
    assert.equal(result.body.data.subscription.status, 'Upcoming');
    assert.equal(result.body.data.subscription.expiresOn, addDays(start, 364));
    const history = await getHistory();
    assert.equal(history[0].action, 'Changed');
    assert.equal(history[0].previousSubscription.planId, plan.id);
  });

  it('deactivates plans without changing existing subscriptions and blocks new assignments or renewals', async () => {
    const before = await getGym();
    assert.equal((await request(`/subscription-plans/${alternative.id}`, { token: superadmin.accessToken, method: 'PATCH', body: { isActive: false } })).status, 200);
    const active = await request('/subscription-plans?active=true', { token: superadmin.accessToken });
    assert.ok(!active.body.data.some((item) => item.id === alternative.id));
    assert.deepEqual((await getGym()).subscription, before.subscription);
    assert.equal((await change({ action: 'renew', revision: before.subscriptionRevision })).status, 400);
    assert.equal((await change({ action: 'assign', planId: alternative.id, startsOn: todayInIndia(), revision: before.subscriptionRevision })).status, 400);
    assert.equal((await request('/gyms', { token: superadmin.accessToken, method: 'POST', body: { ...gymValues('inactive-plan'), planId: alternative.id } })).status, 400);
    assert.equal((await getGym()).subscriptionRevision, before.subscriptionRevision);
    assert.equal((await request(`/subscription-plans/${alternative.id}`, { token: superadmin.accessToken, method: 'PATCH', body: { isActive: true } })).status, 200);
  });

  it('cancels subscriptions and requires assignment before a cancelled subscription can be renewed', async () => {
    const before = await getGym();
    const cancelled = await change({ action: 'cancel', revision: before.subscriptionRevision });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.subscription.status, 'Cancelled');
    assert.equal((await getHistory())[0].action, 'Cancelled');
    const revision = cancelled.body.data.subscriptionRevision;
    assert.equal((await change({ action: 'renew', revision })).status, 400);
    assert.equal((await change({ action: 'cancel', revision })).status, 400);
    const assigned = await change({ action: 'assign', planId: plan.id, startsOn: todayInIndia(), revision });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.data.subscription.status, 'Active');
  });

  it('supports gyms created before subscriptions were introduced', async () => {
    await Gym.updateOne({ _id: newGym.id }, { $unset: { subscription: 1, subscriptionRevision: 1 } });
    const legacy = await getGym(newGym.id);
    assert.equal(legacy.subscription, null);
    assert.equal(legacy.subscriptionRevision, 0);
    const assigned = await change({ action: 'assign', planId: plan.id, startsOn: todayInIndia(), revision: 0 }, newGym.id);
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.data.subscription.status, 'Active');
  });

  it('rolls back a subscription update when its history cannot be saved', async (t) => {
    const before = await getGym();
    const beforeHistory = await getHistory();
    const original = History.create;
    t.mock.method(History, 'create', async () => { throw new Error('Simulated history write failure'); });
    try {
      assert.equal((await change({ action: 'renew', revision: before.subscriptionRevision })).status, 500);
      assert.deepEqual((await getGym()).subscription, before.subscription);
      assert.equal((await getGym()).subscriptionRevision, before.subscriptionRevision);
      assert.equal((await getHistory()).length, beforeHistory.length);
    } finally { History.create = original; }
  });

  it('validates action, revision, object IDs, and missing gyms', async () => {
    const current = await getGym();
    assert.equal((await change({ action: 'renew' })).status, 400);
    assert.equal((await change({ action: 'delete', revision: current.subscriptionRevision })).status, 400);
    assert.equal((await change({ action: 'renew', revision: current.subscriptionRevision }, 'invalid')).status, 400);
    assert.equal((await change({ action: 'renew', revision: 0 }, new mongoose.Types.ObjectId().toString())).status, 404);
    assert.equal((await request('/gyms/invalid/subscription/history', { token: superadmin.accessToken })).status, 400);
  });

  it('handles month boundaries, leap years, and expiry-day status consistently', () => {
    assert.equal(subscriptionSnapshot({ _id: plan._id, name: 'One day', pricePaise: 0, currency: 'INR', durationDays: 1 }, '2026-12-31').expiresOn, '2026-12-31');
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2028-02-28', 2), '2028-03-01');
    const example = { plan: plan._id, startsOn: '2026-12-01', expiresOn: '2026-12-31', state: 'Active' };
    assert.equal(publicSubscription(example, '2026-12-31').status, 'Active');
    assert.equal(publicSubscription(example, '2027-01-01').status, 'Expired');
    assert.equal(publicSubscription(example, '2026-11-30').status, 'Upcoming');
    assert.equal(publicSubscription({ ...example, state: 'Cancelled' }, '2026-12-31').status, 'Cancelled');
  });
});

describe('Subscription plan master fields and removal', { concurrency: false }, () => {
  let master, assignedGym;
  const call = (path, method, body, token = superadmin.accessToken) => request(path, { method, body, token });
  const values = {
    name: 'Basic Quarterly', code: 'basic', price: '25.50', pricing: 'PER_MEMBER',
    pricePerMember: '50.25', durationDays: 90, isActive: true,
  };

  before(async () => { superadmin = await signIn(credentials.email, credentials.password); });

  it('creates gyms with omitted or blank optional address and city', async () => {
    for (const [index, optional] of [{}, { address: '   ', city: '' }].entries()) {
      const values = gymValues(`optional-address-${index}`);
      delete values.address;
      delete values.city;
      const response = await call('/gyms', 'POST', { ...values, ...optional });
      assert.equal(response.status, 201);
      assert.equal(response.body.data.address, '');
      assert.equal(response.body.data.city, '');
      const saved = await Gym.findById(response.body.data.id);
      assert.equal(saved.address, '');
    }
  });

  it('reads older rates as member pricing without losing saved amounts', () => {
    const legacy = { _id: new mongoose.Types.ObjectId(), pricing: 'PER_EMPLOYEE', pricePerEmployeePaise: 5025, pricePerMemberPaise: 0 };
    assert.equal(publicPlan(legacy).pricing, 'PER_MEMBER');
    assert.equal(publicPlan(legacy).pricePerMemberPaise, 5025);
    assert.equal(publicSubscription(legacy).pricePerMemberPaise, 5025);
    assert.equal(publicPlan(legacy).pricePerEmployeePaise, undefined);
  });

  it('persists plan code, pricing, decimal rates, without attendance services', async () => {
    const response = await call('/subscription-plans', 'POST', values);
    assert.equal(response.status, 201);
    master = response.body.data;
    assert.equal(master.code, 'BASIC');
    assert.equal(master.pricing, 'PER_MEMBER');
    assert.equal(master.pricePaise, 2550);
    assert.equal(master.pricePerMemberPaise, 5025);
    assert.equal(master.services, undefined);
    const stored = await Plan.findById(master.id);
    assert.equal(stored.pricePerMemberPaise, 5025);
    const listed = await call('/subscription-plans', 'GET');
    assert.deepEqual(listed.body.data.find((item) => item.id === master.id), master);
  });

  it('rejects invalid codes, pricing and member rates', async () => {
    for (const invalid of [
      { code: 'INVALID CODE' }, { code: 'A'.repeat(31) }, { pricing: 'OTHER' },
      { pricePerMember: '-1' }, { pricePerMember: '1.001' }, { pricePerMember: '10000001' },
    ]) {
      const result = await call('/subscription-plans', 'POST', { ...values, name: 'Invalid new master', ...invalid });
      assert.equal(result.status, 400, JSON.stringify(invalid));
    }
    const missingRate = { ...values, name: 'Missing rate' };
    delete missingRate.pricePerMember;
    assert.equal((await call('/subscription-plans', 'POST', missingRate)).status, 400);
  });

  it('snapshots member pricing when assigning and preserves them after master edits', async () => {
    const created = await call('/gyms', 'POST', { ...gymValues('master-fields'), planId: master.id });
    assert.equal(created.status, 201);
    assignedGym = created.body.data;
    assert.equal(assignedGym.subscription.pricing, 'PER_MEMBER');
    assert.equal(assignedGym.subscription.pricePerMemberPaise, 5025);
    assert.equal(assignedGym.subscription.code, 'BASIC');
    assert.equal(assignedGym.subscription.services, undefined);
    const updated = await call(`/subscription-plans/${master.id}`, 'PATCH', { pricePerMember: '80' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.pricePerMemberPaise, 8000);
    assert.equal(updated.body.data.code, 'BASIC');
    const gyms = await call('/gyms', 'GET');
    assert.deepEqual(gyms.body.data.find((item) => item.id === assignedGym.id).subscription, assignedGym.subscription);
    const history = await call(`/gyms/${assignedGym.id}/subscription/history`, 'GET');
    assert.equal(history.body.data[0].subscription.pricePerMemberPaise, 5025);
    assert.equal(history.body.data[0].subscription.services, undefined);
  });

  it('allows shared codes and clears the member rate when switching to fixed pricing', async () => {
    const created = await call('/subscription-plans', 'POST', { ...values, name: 'Basic Yearly', durationDays: 365 });
    assert.equal(created.status, 201);
    const changed = await call(`/subscription-plans/${created.body.data.id}`, 'PATCH', { pricing: 'FIXED', price: '500' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.pricePaise, 50000);
    assert.equal(changed.body.data.pricePerMemberPaise, 0);
    assert.equal(changed.body.data.pricing, 'FIXED');
  });

  it('restricts removal to Superadmin', async () => {
    assert.equal((await request(`/subscription-plans/${master.id}`, { method: 'DELETE' })).status, 401);
    assert.equal((await call(`/subscription-plans/${master.id}`, 'DELETE', undefined, gymadmin.accessToken)).status, 403);
  });

  it('removes a plan from future use while preserving assigned terms and history', async () => {
    const removed = await call(`/subscription-plans/${master.id}`, 'DELETE');
    assert.equal(removed.status, 200);
    const stored = await Plan.findById(master.id);
    assert.ok(stored.archivedAt);
    assert.equal(stored.isActive, false);
    const listed = await call('/subscription-plans', 'GET');
    assert.equal(listed.body.data.some((item) => item.id === master.id), false);
    assert.equal((await call(`/subscription-plans/${master.id}`, 'PATCH', { isActive: true })).status, 404);
    assert.equal((await call('/gyms', 'POST', { ...gymValues('removed-plan'), planId: master.id })).status, 400);
    assert.equal((await call(`/gyms/${assignedGym.id}/subscription`, 'PATCH', { action: 'renew', revision: assignedGym.subscriptionRevision })).status, 400);
    const gyms = await call('/gyms', 'GET');
    assert.deepEqual(gyms.body.data.find((item) => item.id === assignedGym.id).subscription, assignedGym.subscription);
    const history = await call(`/gyms/${assignedGym.id}/subscription/history`, 'GET');
    assert.equal(history.body.data.length, 1);
    assert.deepEqual(history.body.data[0].subscription, assignedGym.subscription);
  });
});
