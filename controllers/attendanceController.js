import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import Attendance from '../models/attendanceModel.js';
import Member from '../models/memberModel.js';
import Gym from '../models/gymModel.js';
import { memberScope } from './memberManagementController.js';
import { objectId } from '../services/subscriptionService.js';
import { text, HttpError } from '../utils/validation.js';
import { todayInIndia } from '../utils/subscription.js';
import { attendanceDay, csvCell, dayMinutes, QR_PREFIX, qrToken, REPUNCH_DELAY_MS } from '../utils/attendance.js';
import { successResponse } from '../utils/response.js';

const actor = (user) => ({ id: user._id, name: user.name });
const escapeSearch = (value) => text(value, 'Search', 0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function paging(query, total) {
  const pageSize = [5, 10, 25, 50, 100].includes(Number(query.pageSize)) ? Number(query.pageSize) : 10;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requested = Number(query.page);
  const pageNumber = Math.min(totalPages, Number.isSafeInteger(requested) && requested > 0 ? requested : 1);
  return { pageNumber, pageSize, total, totalPages, hasNextPage: pageNumber < totalPages, hasPrevPage: pageNumber > 1 };
}
async function visitScope(req) {
  if (req.user.role === 'GYMADMIN') return { gym: req.user.gym };
  const members = await Member.find(memberScope(req)).select('_id');
  return { gym: req.user.gym, member: { $in: members.map((member) => member._id) } };
}
function visitView(item, day) {
  return {
    id: String(item._id), memberId: String(item.member), memberName: item.memberName, memberCode: item.memberCode,
    checkedInAt: item.checkedInAt, checkedOutAt: item.checkedOutAt, checkInSource: item.checkInSource, checkOutSource: item.checkOutSource,
    checkedInBy: item.checkedInBy.name, checkedOutBy: item.checkedOutBy?.name || null,
    durationMinutes: dayMinutes(item, day.start, day.end), status: item.checkedOutAt ? 'Checked out' : 'Inside',
  };
}
async function resolveMember(req, body, session) {
  // Members always punch the profile linked to their login, regardless of supplied IDs or codes.
  const target = req.user.role === 'MEMBER' ? {} : body.memberId ? { _id: objectId(body.memberId, 'Member') } : { memberCode: text(body.memberCode, 'Member code', 1, 40).toUpperCase() };
  if (body.source === 'qr' && !await Gym.exists({ _id: req.user.gym, attendanceQrToken: qrToken(body.qrValue) }).session(session)) throw new HttpError(400, 'Scan the attendance QR displayed at your own gym.');
  const member = await Member.findOneAndUpdate({ ...memberScope(req), ...target }, { $inc: { attendanceRevision: 1 } }, { session, returnDocument: 'after' });
  if (!member) throw new HttpError(404, 'Member not found or not available to your account.');
  return member;
}
export async function punchAttendance(req, res) {
  const body = req.body || {};
  if (!['self', 'manual', 'qr'].includes(body.source)) throw new HttpError(400, 'Choose self-service, manual or QR attendance.');
  if (req.user.role === 'MEMBER' && body.source === 'manual') throw new HttpError(403, 'Manual attendance can only be recorded by your Gym Admin.');
  if (req.user.role === 'GYMADMIN' && body.source !== 'manual') throw new HttpError(403, 'Member check-in and check-out must use the member’s own login. Use manual attendance for admin entries.');
  if (!['check-in', 'check-out'].includes(body.action)) throw new HttpError(400, 'Choose check-in or check-out.');
  let result;
  try {
    await mongoose.connection.transaction(async (session) => {
      const member = await resolveMember(req, body, session);
      const now = new Date();
      const open = await Attendance.findOne({ gym: req.user.gym, member: member._id, checkedOutAt: null }).session(session);
      if (body.action === 'check-in') {
        if (open) throw new HttpError(409, `${member.name} is already checked in. Check out the open visit first.`);
        const today = todayInIndia();
        if (!member.isActive || member.membership.startsOn > today || member.membership.expiresOn < today) throw new HttpError(400, 'Check-in requires an active member with a current membership.');
        const latest = await Attendance.findOne({ gym: req.user.gym, member: member._id }).sort({ checkedInAt: -1, _id: -1 }).session(session);
        if (latest?.checkedOutAt && now.getTime() - latest.checkedOutAt.getTime() < REPUNCH_DELAY_MS) throw new HttpError(409, 'Please wait 60 seconds after check-out before checking in again.');
        [result] = await Attendance.create([{ gym: req.user.gym, member: member._id, memberName: member.name, memberCode: member.memberCode, checkedInAt: now, checkInSource: body.source, checkedInBy: actor(req.user) }], { session });
      } else {
        if (!open || (body.attendanceId && String(open._id) !== objectId(body.attendanceId, 'Attendance record'))) throw new HttpError(409, 'No matching open visit. This member may already be checked out.');
        result = await Attendance.findOneAndUpdate({ _id: open._id, checkedOutAt: null }, { $set: { checkedOutAt: now, checkOutSource: body.source, checkedOutBy: actor(req.user) } }, { session, returnDocument: 'after' });
        if (!result) throw new HttpError(409, 'This visit was already checked out.');
      }
    });
  } catch (error) {
    if (error.code === 11000) throw new HttpError(409, 'This member already has an open visit. Refresh attendance.');
    throw error;
  }
  return successResponse(res, `${result.memberName} checked ${body.action === 'check-in' ? 'in' : 'out'}.`, visitView(result, attendanceDay()), null, null, body.action === 'check-in' ? 201 : 200);
}

export async function gymAttendanceQr(req, res) {
  const gym = await Gym.findById(req.user.gym).select('+attendanceQrToken');
  if (!gym) throw new HttpError(404, 'Gym not found.');
  let token = gym.attendanceQrToken;
  if (!token) {
    const updated = await Gym.findOneAndUpdate({ _id: gym._id, attendanceQrToken: null }, { $set: { attendanceQrToken: randomBytes(32).toString('hex') } }, { returnDocument: 'after' }).select('+attendanceQrToken');
    token = updated?.attendanceQrToken || (await Gym.findById(gym._id).select('+attendanceQrToken'))?.attendanceQrToken;
  }
  return successResponse(res, 'Gym attendance QR loaded.', { gymName: gym.name, qrValue: `${QR_PREFIX}${token}` });
}

export async function myAttendance(req, res) {
  const member = await Member.findOne(memberScope(req));
  if (!member) throw new HttpError(404, 'No member profile is linked to your login. Contact your Gym Admin.');
  const latest = await Attendance.findOne({ gym: req.user.gym, member: member._id }).sort({ checkedInAt: -1, _id: -1 });
  const open = latest && !latest.checkedOutAt ? latest : null;
  const today = todayInIndia();
  const membershipStatus = !member.isActive ? 'Inactive' : member.membership.startsOn > today ? 'Upcoming' : member.membership.expiresOn < today ? 'Expired' : 'Active';
  const nextTime = latest?.checkedOutAt ? new Date(latest.checkedOutAt.getTime() + REPUNCH_DELAY_MS) : null;
  const nextCheckInAt = nextTime && nextTime > new Date() ? nextTime : null;
  return successResponse(res, 'Your attendance status loaded.', {
    memberId: String(member._id), memberName: member.name, memberCode: member.memberCode, membershipStatus,
    openVisit: open ? visitView(open, attendanceDay()) : null,
    canCheckIn: membershipStatus === 'Active' && !open && !nextCheckInAt, nextCheckInAt,
  });
}

async function reportFilters(req) {
  const day = attendanceDay(req.query.date);
  const scope = await visitScope(req);
  const daily = { ...scope, checkedInAt: { $lt: day.end }, $or: [{ checkedOutAt: null }, { checkedOutAt: { $gt: day.start } }] };
  const filter = { ...daily };
  if (req.query.status && !['all', 'inside', 'checked-out'].includes(req.query.status)) throw new HttpError(400, 'Invalid attendance status.');
  if (req.query.status === 'inside') filter.checkedOutAt = null;
  if (req.query.status === 'checked-out') filter.checkedOutAt = { $ne: null };
  if (req.query.search) filter.$and = [{ $or: ['memberName', 'memberCode'].map((field) => ({ [field]: { $regex: escapeSearch(req.query.search), $options: 'i' } })) }];
  return { day, scope, daily, filter };
}
export async function dailyAttendance(req, res) {
  const { day, scope, daily, filter } = await reportFilters(req);
  const [total, checkIns, checkOuts, present, insideNow] = await Promise.all([
    Attendance.countDocuments(filter), Attendance.countDocuments({ ...scope, checkedInAt: { $gte: day.start, $lt: day.end } }),
    Attendance.countDocuments({ ...scope, checkedOutAt: { $gte: day.start, $lt: day.end } }),
    Attendance.distinct('member', daily), Attendance.countDocuments({ ...scope, checkedOutAt: null }),
  ]);
  const pagination = paging(req.query, total);
  const records = await Attendance.find(filter).sort({ checkedInAt: -1, _id: -1 }).skip((pagination.pageNumber - 1) * pagination.pageSize).limit(pagination.pageSize);
  return res.json({ success: true, message: 'Daily attendance loaded.', data: { date: day.date, summary: { checkIns, checkOuts, presentMembers: present.length, insideNow }, records: records.map((record) => visitView(record, day)) }, meta: { pagination } });
}
export async function exportAttendance(req, res) {
  const { day, filter } = await reportFilters(req);
  if (await Attendance.countDocuments(filter) > 50_000) throw new HttpError(400, 'Narrow the search to export at most 50000 visits.');
  const records = await Attendance.find(filter).sort({ checkedInAt: -1, _id: -1 });
  const timestamp = (value) => value ? value.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }) : '';
  const rows = [['Member code', 'Member name', 'Check-in (India)', 'Check-out (India)', 'Minutes on report date', 'Status', 'Check-in method', 'Check-out method', 'Recorded by', 'Checked out by'], ...records.map((record) => [
    record.memberCode, record.memberName, timestamp(record.checkedInAt), timestamp(record.checkedOutAt), dayMinutes(record, day.start, day.end), record.checkedOutAt ? 'Checked out' : 'Inside', record.checkInSource, record.checkOutSource || '', record.checkedInBy.name, record.checkedOutBy?.name || '',
  ])];
  return successResponse(res, 'Attendance report exported.', { filename: `attendance-${day.date}.csv`, csv: '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') });
}

export async function attendanceActivity(req, res) {
  const memberFilter = memberScope(req);
  if (req.query.search) memberFilter.$or = ['name', 'memberCode', 'phone'].map((field) => ({ [field]: { $regex: escapeSearch(req.query.search), $options: 'i' } }));
  const status = req.query.activity || 'all';
  if (!['all', 'recent', 'inactive', 'never', 'inside'].includes(status)) throw new HttpError(400, 'Invalid member activity filter.');
  const since = new Date(Date.now() - 30 * 86400_000);
  const stages = [
    { $match: memberFilter },
    { $lookup: { from: Attendance.collection.name, let: { memberId: '$_id', gymId: '$gym' }, pipeline: [
      { $match: { $expr: { $and: [{ $eq: ['$member', '$$memberId'] }, { $eq: ['$gym', '$$gymId'] }] } } },
      { $sort: { checkedInAt: -1, _id: -1 } }, { $limit: 1 },
    ], as: 'lastVisit' } },
    { $set: { lastVisit: { $arrayElemAt: ['$lastVisit', 0] } } },
    { $set: { lastVisitAt: { $ifNull: ['$lastVisit.checkedInAt', null] }, openVisitId: { $cond: [{ $and: [{ $ne: [{ $ifNull: ['$lastVisit._id', null] }, null] }, { $eq: ['$lastVisit.checkedOutAt', null] }] }, '$lastVisit._id', null] } } },
    { $set: { activity: { $cond: [{ $eq: ['$lastVisitAt', null] }, 'never', { $cond: [{ $gte: ['$lastVisitAt', since] }, 'recent', 'inactive'] }] } } },
  ];
  const activityFilter = status === 'all' ? {} : status === 'inside' ? { openVisitId: { $ne: null } } : { activity: status };
  const counts = await Member.aggregate([...stages, { $facet: {
    summary: [{ $group: { _id: null, total: { $sum: 1 }, recent: { $sum: { $cond: [{ $eq: ['$activity', 'recent'] }, 1, 0] } }, inactive: { $sum: { $cond: [{ $eq: ['$activity', 'inactive'] }, 1, 0] } }, never: { $sum: { $cond: [{ $eq: ['$activity', 'never'] }, 1, 0] } }, accountActive: { $sum: { $cond: ['$isActive', 1, 0] } }, accountInactive: { $sum: { $cond: ['$isActive', 0, 1] } } } }],
    filtered: [{ $match: activityFilter }, { $count: 'total' }],
  } }]);
  const pagination = paging(req.query, counts[0].filtered[0]?.total || 0);
  const members = await Member.aggregate([...stages, { $match: activityFilter }, { $sort: { name: 1, _id: 1 } }, { $skip: (pagination.pageNumber - 1) * pagination.pageSize }, { $limit: pagination.pageSize }]);
  const { _id, ...summary } = counts[0].summary[0] || { total: 0, recent: 0, inactive: 0, never: 0, accountActive: 0, accountInactive: 0 };
  const today = todayInIndia();
  return res.json({ success: true, message: 'Member attendance activity loaded.', data: { summary, since, members: members.map((member) => ({
    id: String(member._id), name: member.name, memberCode: member.memberCode, lastVisitAt: member.lastVisitAt, openVisitId: member.openVisitId ? String(member.openVisitId) : null, activity: member.activity,
    membershipStatus: !member.isActive ? 'Inactive' : member.membership.startsOn > today ? 'Upcoming' : member.membership.expiresOn < today ? 'Expired' : 'Active',
  })) }, meta: { pagination } });
}
