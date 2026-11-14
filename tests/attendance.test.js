import { after, before, beforeEach, describe, it } from 'node:test';
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
import Attendance from '../models/attendanceModel.js';
import { attendanceDay, csvCell, dayMinutes, qrToken } from '../utils/attendance.js';
import { addDays, todayInIndia } from '../utils/subscription.js';

let database, server, base, gym, otherGym, member, otherMember, inactiveMember, foreignMember, accounts;
const tokens = {};
const today = todayInIndia();
async function request(path, actor = 'admin', method = 'GET', body) {
  const response = await fetch(`${base}/api/attendance${path}`, { method, headers: { 'Content-Type': 'application/json', ...(tokens[actor] ? { Authorization: `Bearer ${tokens[actor]}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
const punch = (extra = {}) => ({ source: 'manual', action: 'check-in', memberId: String(member._id), ...extra });
const seedVisit = (target, extra = {}) => Attendance.create({ gym: target.gym, member: target._id, memberName: target.name, memberCode: target.memberCode, checkedInAt: new Date(Date.now() - 3600_000), checkInSource: 'manual', checkedInBy: { id: accounts[0]._id, name: accounts[0].name }, ...extra });
before(async () => {
  process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex'); process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri(), { dbName: 'attendance-tests' });
  gym = new mongoose.Types.ObjectId(); otherGym = new mongoose.Types.ObjectId();
  const passwordHash = await bcrypt.hash('Attendance123!', 4);
  accounts = await User.create([
    { name: 'Gym admin', email: 'attendance-admin@example.test', role: 'GYMADMIN', gym, passwordHash },
    { name: 'Other admin', email: 'attendance-other@example.test', role: 'GYMADMIN', gym: otherGym, passwordHash },
    { name: 'Assigned trainer', email: 'attendance-trainer@example.test', role: 'TRAINER', gym, passwordHash },
    { name: 'Unassigned trainer', email: 'attendance-unassigned@example.test', role: 'TRAINER', gym, passwordHash },
    { name: 'Member login', email: 'attendance-member@example.test', role: 'MEMBER', gym, passwordHash },
    { name: 'Root', email: 'attendance-root@example.test', role: 'SUPERADMIN', passwordHash },
  ]);
  await Gym.create([
    { _id: gym, name: 'Attendance gym', email: 'attendance-gym@example.test', phone: '9876543210', admin: accounts[0]._id, createdBy: accounts[5]._id },
    { _id: otherGym, name: 'Other gym', email: 'attendance-foreign@example.test', phone: '9876543211', admin: accounts[1]._id, createdBy: accounts[5]._id },
  ]);
  const plan = await MemberPlan.create({ gym, name: 'Attendance plan', nameKey: 'attendance plan', code: 'ATTENDANCE', pricePaise: 50000, durationMonths: 1, trainerIncluded: true });
  const membership = { plan: plan._id, planName: plan.name, pricePaise: 50000, durationMonths: 1, trainerIncluded: true, startsOn: today, expiresOn: addDays(today, 30) };
  [member, otherMember, inactiveMember, foreignMember] = await Member.create([
    { gym, name: 'Attendance member', memberNumber: 1, memberCode: 'MEM0001', phone: '9876543210', joinedOn: today, trainer: accounts[2]._id, user: accounts[4]._id, membership },
    { gym, name: 'Another member', memberNumber: 2, memberCode: 'MEM0002', phone: '9876543211', joinedOn: today, membership },
    { gym, name: 'Inactive member', memberNumber: 3, memberCode: 'MEM0003', phone: '9876543212', joinedOn: today, isActive: false, membership },
    { gym: otherGym, name: 'Foreign member', memberNumber: 1, memberCode: 'MEM0001', phone: '9876543213', joinedOn: today, membership },
  ]);
  await Promise.all([Member.init(), Attendance.init()]);
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  for (const [index, actor] of ['admin', 'otherAdmin', 'trainer', 'unassigned', 'member', 'root'].entries()) {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: accounts[index].email, password: 'Attendance123!' }) });
    assert.equal(response.status, 200); tokens[actor] = (await response.json()).data.accessToken;
  }
}, { timeout: 120_000 });
beforeEach(async () => {
  await Attendance.deleteMany({});
  await Member.updateOne({ _id: member._id }, { $set: { isActive: true, deletedAt: null, user: accounts[4]._id, trainer: accounts[2]._id, 'membership.startsOn': today, 'membership.expiresOn': addDays(today, 30) } });
});
after(async () => { if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } await mongoose.disconnect(); if (database) await database.stop(); });

describe('Attendance management', { concurrency: false }, () => {
  it('starts empty and scopes reports and activity by authenticated role', async () => {
    const report = await request(''); assert.equal(report.status, 200); assert.deepEqual(report.body.data.summary, { checkIns: 0, checkOuts: 0, presentMembers: 0, insideNow: 0 });
    assert.equal((await request('/activity')).body.data.members.length, 3);
    assert.equal((await request('/activity', 'trainer')).body.data.members.length, 1);
    assert.equal((await request('/activity', 'member')).body.data.members[0].id, String(member._id));
    assert.equal((await request('/activity', 'unassigned')).body.data.members.length, 0);
    assert.equal((await request('', 'none')).status, 401); assert.equal((await request('', 'root')).status, 403);
  });
  it('records manual check-in/out with server times and actor, retaining the profile revision', async () => {
    const revision = (await Member.findById(member._id)).revision;
    const checkIn = await request('/punch', 'admin', 'POST', punch({ checkedInAt: '2001-01-01', gym: String(otherGym), checkedInBy: { name: 'Forged' } }));
    assert.equal(checkIn.status, 201); const record = checkIn.body.data;
    assert.equal(record.memberName, member.name); assert.equal(record.checkedInBy, 'Gym admin'); assert.equal(record.checkInSource, 'manual');
    assert.ok(Math.abs(Date.now() - Date.parse(record.checkedInAt)) < 5000);
    assert.equal((await Member.findById(member._id)).revision, revision);
    const checkOut = await request('/punch', 'admin', 'POST', punch({ action: 'check-out', attendanceId: record.id }));
    assert.equal(checkOut.status, 200); assert.equal(checkOut.body.data.status, 'Checked out'); assert.equal(checkOut.body.data.checkedOutBy, 'Gym admin');
    assert.equal(await Attendance.countDocuments(), 1);
  });
  it('prevents duplicate and concurrent check-ins and enforces the unique open-visit index', async () => {
    const results = await Promise.all([1, 2].map(() => request('/punch', 'admin', 'POST', punch())));
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    assert.equal((await request('/punch', 'member', 'POST', { action: 'check-in', source: 'self' })).status, 409);
    assert.equal(await Attendance.countDocuments(), 1);
    await assert.rejects(() => seedVisit(member), { code: 11000 });
  });
  it('prevents duplicate and concurrent check-outs and stale session requests', async () => {
    const visit = await seedVisit(member);
    assert.equal((await request('/punch', 'admin', 'POST', punch({ action: 'check-out', attendanceId: String(new mongoose.Types.ObjectId()) }))).status, 409);
    const results = await Promise.all([1, 2].map(() => request('/punch', 'admin', 'POST', punch({ action: 'check-out', attendanceId: String(visit._id) }))));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal((await request('/punch', 'admin', 'POST', punch({ action: 'check-out' }))).status, 409);
  });
  it('blocks immediate re-entry but permits another visit after the duplicate-punch window', async () => {
    const visit = await seedVisit(member, { checkedOutAt: new Date() });
    assert.equal((await request('/punch', 'admin', 'POST', punch())).status, 409);
    await Attendance.updateOne({ _id: visit._id }, { $set: { checkedOutAt: new Date(Date.now() - 61_000) } });
    assert.equal((await request('/punch', 'admin', 'POST', punch())).status, 201);
    assert.equal(await Attendance.countDocuments({ member: member._id }), 2);
  });
  it('requires current active membership for check-in and still allows closing an existing visit', async () => {
    assert.equal((await request('/punch', 'admin', 'POST', punch({ memberId: String(inactiveMember._id) }))).status, 400);
    for (const terms of [{ 'membership.expiresOn': addDays(today, -1) }, { 'membership.startsOn': addDays(today, 1) }, { isActive: false }]) {
      await Member.updateOne({ _id: member._id }, { $set: { isActive: true, 'membership.startsOn': today, 'membership.expiresOn': addDays(today, 30), ...terms } });
      assert.equal((await request('/punch', 'admin', 'POST', punch())).status, 400);
    }
    await seedVisit(member);
    assert.equal((await request('/punch', 'admin', 'POST', punch({ action: 'check-out' }))).status, 200);
  });
  it('limits manual entries to the gym admin and keeps trainer attendance read-only', async () => {
    assert.equal((await request('/punch', 'member', 'POST', punch())).status, 403);
    assert.equal((await request('/punch', 'otherAdmin', 'POST', punch())).status, 404);
    for (const actor of ['trainer', 'unassigned']) assert.equal((await request('/punch', actor, 'POST', punch())).status, 403);
    assert.equal((await request('/punch', 'trainer', 'POST', punch({ memberId: String(otherMember._id) }))).status, 403);
    assert.equal((await request('/punch', 'admin', 'POST', punch({ memberId: String(foreignMember._id) }))).status, 404);
    assert.equal(await Attendance.countDocuments(), 0);
  });
  it('issues a stable gym QR which members scan from their own login', async () => {
    const passes = await Promise.all([1, 2].map(() => request('/qr-code', 'admin', 'POST', {})));
    assert.equal(passes[0].status, 200); assert.equal(passes[0].body.data.qrValue, passes[1].body.data.qrValue);
    const qrValue = passes[0].body.data.qrValue; assert.match(qrValue, /^GYMATTEND:1:[a-f0-9]{64}$/); assert.ok(!qrValue.includes(String(member._id)));
    assert.equal(passes[0].body.data.gymName, 'Attendance gym');
    for (const actor of ['member', 'trainer', 'unassigned']) assert.equal((await request('/qr-code', actor, 'POST', {})).status, 403);
    const foreign = await request('/qr-code', 'otherAdmin', 'POST', {});
    assert.equal((await request('/punch', 'member', 'POST', { source: 'qr', action: 'check-in', qrValue: foreign.body.data.qrValue })).status, 400);
    assert.equal((await request('/punch', 'admin', 'POST', { source: 'qr', action: 'check-in', qrValue })).status, 403);
    const checkIn = await request('/punch', 'member', 'POST', { source: 'qr', action: 'check-in', qrValue, memberId: String(foreignMember._id) });
    assert.equal(checkIn.status, 201); assert.equal(checkIn.body.data.checkInSource, 'qr');
    assert.equal(checkIn.body.data.memberId, String(member._id)); assert.equal(checkIn.body.data.checkedInBy, 'Member login');
    assert.equal((await request('/punch', 'member', 'POST', { source: 'qr', action: 'check-in', qrValue })).status, 409);
    const checkOut = await request('/punch', 'member', 'POST', { source: 'qr', action: 'check-out', qrValue });
    assert.equal(checkOut.status, 200); assert.equal(checkOut.body.data.checkOutSource, 'qr');
    assert.equal((await Gym.findById(gym).lean()).attendanceQrToken, undefined);
  });
  it('rejects malformed punches, QR values, dates and filters without recording visits', async () => {
    for (const body of [punch({ source: 'other' }), punch({ action: 'toggle' }), punch({ memberId: 'invalid' }), { source: 'manual', action: 'check-in', memberCode: { $ne: null } }, { source: 'qr', action: 'check-in', qrValue: String(member._id) }, { source: 'qr', action: 'check-in', qrValue: { $ne: null } }]) assert.equal((await request('/punch', body.source === 'qr' ? 'member' : 'admin', 'POST', body)).status, 400);
    for (const query of ['?date=2026-02-30', `?date=${addDays(today, 1)}`, '?status=unknown']) assert.equal((await request(query)).status, 400);
    assert.equal((await request('/activity?activity=unknown')).status, 400); assert.equal(await Attendance.countDocuments(), 0);
    assert.throws(() => qrToken('anything'), /valid gym/);
  });
  it('reports midnight-spanning visits in India time without double-counting members', async () => {
    const day = attendanceDay('2024-02-29');
    await seedVisit(member, { checkedInAt: new Date(day.start.getTime() - 3600_000), checkedOutAt: new Date(day.end.getTime() + 3600_000) });
    await seedVisit(otherMember, { checkedInAt: new Date(day.start.getTime() + 3600_000), checkedOutAt: new Date(day.start.getTime() + 3 * 3600_000) });
    await seedVisit(foreignMember, { checkedInAt: day.start, checkedOutAt: day.end });
    const report = await request('?date=2024-02-29');
    assert.equal(report.status, 200); assert.deepEqual(report.body.data.summary, { checkIns: 1, checkOuts: 1, presentMembers: 2, insideNow: 0 });
    assert.equal(report.body.data.records.find((record) => record.memberId === String(member._id)).durationMinutes, 1440);
    assert.equal(report.body.data.records.find((record) => record.memberId === String(otherMember._id)).durationMinutes, 120);
    const own = await request('?date=2024-02-29', 'member'); assert.equal(own.body.data.records.length, 1);
    assert.equal(own.body.data.summary.presentMembers, 1);
    assert.equal((await request('?date=2024-02-29', 'unassigned')).body.data.records.length, 0);
  });
  it('keeps report boundaries, search, pagination and exports consistent', async () => {
    const day = attendanceDay('2024-02-29');
    await seedVisit(member, { checkedInAt: new Date(day.start.getTime() - 3600_000), checkedOutAt: day.start });
    await seedVisit(member, { checkedInAt: day.end, checkedOutAt: new Date(day.end.getTime() + 3600_000) });
    await Attendance.insertMany(Array.from({ length: 7 }, (_, index) => ({ gym, member: otherMember._id, memberName: '=BAD, "name"', memberCode: otherMember.memberCode, checkedInAt: new Date(day.start.getTime() + (index + 1) * 600_000), checkedOutAt: new Date(day.start.getTime() + (index + 2) * 600_000), checkInSource: 'manual', checkedInBy: { id: accounts[0]._id, name: accounts[0].name } })));
    const report = await request('?date=2024-02-29&pageSize=5&page=99'); assert.equal(report.body.meta.pagination.total, 7); assert.equal(report.body.meta.pagination.pageNumber, 2); assert.equal(report.body.data.records.length, 2);
    assert.equal((await request('?date=2024-02-29&search=MEM0002')).body.meta.pagination.total, 7);
    assert.equal((await request('?date=2024-02-29&search=.*')).body.meta.pagination.total, 0);
    const exported = await request('/export?date=2024-02-29&search=MEM0002'); assert.equal(exported.status, 200); assert.equal(exported.body.data.filename, 'attendance-2024-02-29.csv');
    assert.equal(exported.body.data.csv.split('\r\n').length, 8); assert.ok(exported.body.data.csv.includes("'=BAD")); assert.ok(exported.body.data.csv.includes('""name""'));
    assert.equal((await request('/export?date=2024-02-29', 'member')).body.data.csv.split('\r\n').length, 1);
    assert.equal(csvCell('+SUM(1,2)'), '"\'+SUM(1,2)"');
  });
  it('distinguishes recent attendance, no recent visits, never visited and membership status', async () => {
    await seedVisit(member);
    await seedVisit(otherMember, { checkedInAt: new Date(Date.now() - 40 * 86400_000), checkedOutAt: new Date(Date.now() - 40 * 86400_000 + 3600_000) });
    const activity = await request('/activity'); assert.equal(activity.status, 200);
    assert.deepEqual(activity.body.data.summary, { total: 3, recent: 1, inactive: 1, never: 1, accountActive: 2, accountInactive: 1 });
    assert.equal(activity.body.data.members.find((item) => item.id === String(member._id)).openVisitId.length, 24);
    assert.equal(activity.body.data.members.find((item) => item.id === String(inactiveMember._id)).membershipStatus, 'Inactive');
    for (const status of ['recent', 'inactive', 'never', 'inside']) assert.equal((await request(`/activity?activity=${status}`)).body.data.members.length, 1);
    assert.equal((await request('/activity?search=MEM0002')).body.data.summary.total, 1);
    assert.equal((await request('/activity?search=.*')).body.data.members.length, 0);
  });
  it('revokes trainer visibility on reassignment and retains admin reports after member removal', async () => {
    await seedVisit(member);
    await Member.updateOne({ _id: member._id }, { $set: { trainer: null } });
    assert.equal((await request('', 'trainer')).body.data.records.length, 0);
    assert.equal((await request('/punch', 'trainer', 'POST', punch({ action: 'check-out' }))).status, 403);
    await Member.updateOne({ _id: member._id }, { $set: { deletedAt: new Date() } });
    assert.equal((await request('')).body.data.records.length, 1);
    assert.equal((await request('/punch', 'admin', 'POST', punch())).status, 404);
    assert.equal((await request('', 'member')).body.data.records.length, 0);
  });
  it('clips open-visit durations to the report day and current time', () => {
    const day = attendanceDay('2024-02-29');
    assert.equal(day.start.toISOString(), '2024-02-28T18:30:00.000Z');
    assert.equal(dayMinutes({ checkedInAt: day.start, checkedOutAt: null }, day.start, day.end, new Date(day.start.getTime() + 30 * 60000)), 30);
    assert.equal(dayMinutes({ checkedInAt: new Date(day.end.getTime() + 60000), checkedOutAt: null }, day.start, day.end), 0);
  });
  it('records member self punches only for the linked profile despite forged targets', async () => {
    const start = await request('/me', 'member'); assert.equal(start.status, 200); assert.equal(start.body.data.canCheckIn, true); assert.equal(start.body.data.openVisit, null);
    const checkIn = await request('/punch', 'member', 'POST', { action: 'check-in', source: 'self', memberId: String(otherMember._id), memberCode: foreignMember.memberCode, gym: String(otherGym), checkedInBy: { name: 'Admin' } });
    assert.equal(checkIn.status, 201); assert.equal(checkIn.body.data.memberId, String(member._id)); assert.equal(checkIn.body.data.checkedInBy, 'Member login'); assert.equal(checkIn.body.data.checkInSource, 'self');
    assert.equal(await Attendance.countDocuments({ member: otherMember._id }), 0);
    const inside = await request('/me', 'member'); assert.equal(inside.body.data.canCheckIn, false); assert.equal(inside.body.data.openVisit.id, checkIn.body.data.id);
    const checkOut = await request('/punch', 'member', 'POST', { action: 'check-out', source: 'self', attendanceId: checkIn.body.data.id, memberId: String(foreignMember._id) });
    assert.equal(checkOut.status, 200); assert.equal(checkOut.body.data.checkedOutBy, 'Member login'); assert.equal(checkOut.body.data.checkOutSource, 'self');
    const ended = await request('/me', 'member'); assert.equal(ended.body.data.openVisit, null); assert.equal(ended.body.data.canCheckIn, false); assert.ok(ended.body.data.nextCheckInAt);
    assert.equal((await request('/punch', 'member', 'POST', { action: 'check-out', source: 'self' })).status, 409);
    assert.equal((await request('/punch', 'admin', 'POST', { action: 'check-in', source: 'self' })).status, 403);
    assert.equal((await request('/me', 'admin')).status, 403);
  });
  it('prevents concurrent member self punches and rejects unlinked logins', async () => {
    const results = await Promise.all([1, 2].map(() => request('/punch', 'member', 'POST', { source: 'self', action: 'check-in' })));
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    await Member.updateOne({ _id: member._id }, { $set: { user: null } });
    assert.equal((await request('/me', 'member')).status, 404);
    assert.equal((await request('/punch', 'member', 'POST', { source: 'self', action: 'check-out', memberId: String(member._id) })).status, 404);
  });
});
