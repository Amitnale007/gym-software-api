import Gym from '../models/gymModel.js';
import History from '../models/subscriptionHistoryModel.js';
import { HttpError, publicGym } from '../utils/validation.js';
import { addDays, publicSubscription, subscriptionSnapshot, todayInIndia } from '../utils/subscription.js';
import { activePlan, assignedSubscription, objectId, recordSubscriptionChange, transaction } from '../services/subscriptionService.js';
import { successResponse } from '../utils/response.js';

export async function manageSubscription(req, res) {
  const gymId = objectId(req.params.id, 'Gym');
  const body = req.body || {};
  if (!['assign', 'renew', 'cancel'].includes(body.action)) throw new HttpError(400, 'Choose assign, renew, or cancel.');
  if (!Number.isInteger(body.revision) || body.revision < 0) throw new HttpError(400, 'Subscription revision is required. Refresh the gym list.');
  await transaction(async (session) => {
    const gym = await Gym.findById(gymId).session(session);
    if (!gym) throw new HttpError(404, 'Gym not found.');
    if ((gym.subscriptionRevision || 0) !== body.revision) throw new HttpError(409, 'This subscription was updated. Close this form and refresh the gym list.');
    const previous = gym.subscription?.toObject() || null;
    let next, action, periodStartsOn, periodExpiresOn;
    if (body.action === 'assign') {
      next = await assignedSubscription(body.planId, body.startsOn, session);
      action = previous ? 'Changed' : 'Assigned';
    } else {
      if (!previous) throw new HttpError(400, 'Assign a subscription plan first.');
      if (previous.state === 'Cancelled') throw new HttpError(400, 'This subscription is cancelled. Assign a plan to reactivate it.');
      if (body.action === 'cancel') {
        next = { ...previous, state: 'Cancelled' };
        action = 'Cancelled';
      } else {
        const plan = await activePlan(String(previous.plan), session);
        const today = todayInIndia();
        periodStartsOn = previous.expiresOn >= today ? addDays(previous.expiresOn, 1) : today;
        const period = subscriptionSnapshot(plan, periodStartsOn);
        next = { ...period, startsOn: previous.expiresOn >= today ? previous.startsOn : today };
        periodExpiresOn = period.expiresOn;
        action = 'Renewed';
      }
    }
    gym.subscription = next;
    gym.subscriptionRevision = (gym.subscriptionRevision || 0) + 1;
    await gym.save({ session });
    await recordSubscriptionChange({ gym: gym._id, actor: req.user._id, action, subscription: next, previousSubscription: previous, periodStartsOn, periodExpiresOn }, session);
  });
  const gym = await Gym.findById(gymId).populate('admin', 'name email role gym');
  return successResponse(res, 'Gym subscription updated.', publicGym(gym));
}

export async function subscriptionHistory(req, res) {
  const gymId = objectId(req.params.id, 'Gym');
  if (!await Gym.exists({ _id: gymId })) throw new HttpError(404, 'Gym not found.');
  const events = await History.find({ gym: gymId }).populate('changedBy', 'name email').sort({ createdAt: -1, _id: -1 }).limit(100);
  return successResponse(res, 'Subscription history loaded.', events.map((event) => ({
    id: String(event._id), action: event.action, createdAt: event.createdAt,
    subscription: publicSubscription(event.subscription), previousSubscription: publicSubscription(event.previousSubscription),
    periodStartsOn: event.periodStartsOn, periodExpiresOn: event.periodExpiresOn,
    changedBy: event.changedBy ? { name: event.changedBy.name, email: event.changedBy.email } : null,
  })));
}
