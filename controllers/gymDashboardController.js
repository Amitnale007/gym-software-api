import Member from '../models/memberModel.js';
import User from '../models/userModel.js';
import { memberScope, memberView } from './memberManagementController.js';
import { addDays, todayInIndia } from '../utils/subscription.js';
import { successResponse } from '../utils/response.js';

export async function gymDashboard(req, res) {
  const today = todayInIndia();
  const [year, month] = today.split('-').map(Number);
  const monthStart = `${today.slice(0, 7)}-01`;
  const months = Array.from({ length: 6 }, (_, index) => new Date(Date.UTC(year, month - 6 + index, 1)).toISOString().slice(0, 7));
  const scope = memberScope(req);
  const active = { $and: [{ $eq: ['$isActive', true] }, { $lte: ['$membership.startsOn', today] }, { $gte: ['$membership.expiresOn', today] }] };
  const soon = { $and: [active, { $lte: ['$membership.expiresOn', addDays(today, 7)] }] };
  const [aggregate, recent, renewals, activeTrainers] = await Promise.all([
    Member.aggregate([
      { $match: scope },
      { $facet: {
        counts: [{ $group: {
          _id: null, totalMembers: { $sum: 1 }, activeMembers: { $sum: { $cond: [active, 1, 0] } },
          expiringSoon: { $sum: { $cond: [soon, 1, 0] } },
          expiredMembers: { $sum: { $cond: [{ $and: [{ $eq: ['$isActive', true] }, { $lt: ['$membership.expiresOn', today] }] }, 1, 0] } },
          upcomingMembers: { $sum: { $cond: [{ $and: [{ $eq: ['$isActive', true] }, { $gt: ['$membership.startsOn', today] }] }, 1, 0] } },
          inactiveMembers: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } },
          newThisMonth: { $sum: { $cond: [{ $and: [{ $gte: ['$joinedOn', monthStart] }, { $lte: ['$joinedOn', today] }] }, 1, 0] } },
        } }],
        growth: [
          { $match: { joinedOn: { $gte: `${months[0]}-01`, $lte: today } } },
          { $group: { _id: { $substrBytes: ['$joinedOn', 0, 7] }, count: { $sum: 1 } } },
        ],
      } },
    ]),
    Member.find(scope).populate('trainer', 'name').sort({ createdAt: -1, _id: -1 }).limit(5),
    Member.find({ ...scope, isActive: true, 'membership.startsOn': { $lte: today }, 'membership.expiresOn': { $gte: today, $lte: addDays(today, 7) } }).populate('trainer', 'name').sort({ 'membership.expiresOn': 1, _id: 1 }).limit(5),
    req.user.role === 'GYMADMIN' ? User.countDocuments({ gym: req.user.gym, role: 'TRAINER', isActive: { $ne: false } }) : Promise.resolve(null),
  ]);
  const { _id, ...counts } = aggregate[0].counts[0] || { totalMembers: 0, activeMembers: 0, expiringSoon: 0, expiredMembers: 0, upcomingMembers: 0, inactiveMembers: 0, newThisMonth: 0 };
  return successResponse(res, 'Dashboard loaded.', {
    ...counts, activeTrainers, asOf: today,
    growth: months.map((value) => ({ month: value, count: aggregate[0].growth.find((item) => item._id === value)?.count || 0 })),
    recentMembers: recent.map(memberView), upcomingRenewals: renewals.map(memberView),
  });
}
