import Counter from '../models/memberCounterModel.js';
import { ensureMemberCounter, memberCode } from '../services/memberNumberService.js';
import { HttpError, text } from '../utils/validation.js';
import { successResponse } from '../utils/response.js';

function publicSettings(counter) {
  return { prefix: counter.prefix, padding: counter.padding, nextNumber: counter.value + 1, revision: counter.settingsRevision, preview: memberCode(counter.value + 1, counter.prefix, counter.padding) };
}
export async function getMemberIdSettings(req, res) {
  await ensureMemberCounter(req.user.gym);
  return successResponse(res, 'Member ID settings loaded.', publicSettings(await Counter.findById(req.user.gym)));
}
export async function updateMemberIdSettings(req, res) {
  const body = req.body || {};
  const prefix = text(body.prefix, 'Prefix', 1, 10).toUpperCase();
  if (!/^[A-Z]+$/.test(prefix)) throw new HttpError(400, 'Prefix must contain letters only.');
  if (!Number.isInteger(body.padding) || body.padding < 1 || body.padding > 8) throw new HttpError(400, 'Number length must be 1 to 8 digits.');
  if (!Number.isSafeInteger(body.nextNumber) || body.nextNumber < 1 || body.nextNumber > 999999999) throw new HttpError(400, 'Next number must be from 1 to 999999999.');
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new HttpError(400, 'A current settings revision is required.');
  await ensureMemberCounter(req.user.gym);
  const current = await Counter.findById(req.user.gym);
  if (body.revision !== current.settingsRevision) throw new HttpError(409, 'ID settings changed. Refresh and try again.');
  if (body.nextNumber <= current.value) throw new HttpError(400, `Next number must be at least ${current.value + 1}. Issued numbers cannot be reused.`);
  const updated = await Counter.findOneAndUpdate({ _id: req.user.gym, value: current.value, settingsRevision: body.revision }, {
    $set: { prefix, padding: body.padding, value: body.nextNumber - 1 }, $inc: { settingsRevision: 1 },
  }, { returnDocument: 'after', runValidators: true });
  if (!updated) throw new HttpError(409, 'A member or ID setting changed. Refresh and try again.');
  return successResponse(res, 'Member ID settings saved. Existing IDs are unchanged.', publicSettings(updated));
}
