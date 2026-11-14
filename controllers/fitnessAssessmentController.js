import FitnessAssessment from '../models/fitnessAssessmentModel.js';
import Member from '../models/memberModel.js';
import { memberScope } from './memberManagementController.js';
import { objectId } from '../services/subscriptionService.js';
import { fitnessValues, fitnessSnapshot } from '../utils/fitness.js';
import { HttpError, text } from '../utils/validation.js';
import { successResponse } from '../utils/response.js';

async function scope(req) {
  const member = objectId(req.params.id, 'Member');
  if (!await Member.exists({ ...memberScope(req), _id: member })) throw new HttpError(404, 'Member not found.');
  return { gym: req.user.gym, member };
}
function publicAssessment(item, includeCorrections = true) {
  return {
    id: String(item._id), ...fitnessSnapshot(item), recordedBy: { id: String(item.recordedBy.id), name: item.recordedBy.name },
    revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt,
    ...(includeCorrections ? { corrections: item.corrections.map((correction) => ({
      previous: fitnessSnapshot(correction.previous), previousRevision: correction.previousRevision,
      correctedBy: { id: String(correction.correctedBy.id), name: correction.correctedBy.name },
      correctedAt: correction.correctedAt, reason: correction.reason,
    })) } : {}),
  };
}
const sort = { assessedOn: -1, createdAt: -1, _id: -1 };

export async function listFitnessAssessments(req, res) {
  const filter = await scope(req);
  const pageSize = [5, 10, 25, 50].includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 10;
  const total = await FitnessAssessment.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requested = Number(req.query.page);
  const pageNumber = Math.min(totalPages, Number.isSafeInteger(requested) && requested > 0 ? requested : 1);
  const items = await FitnessAssessment.find(filter).sort(sort).skip((pageNumber - 1) * pageSize).limit(pageSize);
  return res.json({ success: true, message: 'Fitness assessments loaded.', data: items.map((item) => publicAssessment(item)), meta: { pagination: {
    pageNumber, pageSize, total, totalPages, hasNextPage: pageNumber < totalPages, hasPrevPage: pageNumber > 1,
  } } });
}

export async function fitnessSummary(req, res) {
  const filter = await scope(req);
  const items = await FitnessAssessment.find(filter).select('-corrections').sort(sort).limit(100);
  const assessments = items.map((item) => publicAssessment(item, false));
  return successResponse(res, 'Fitness summary loaded.', { latest: assessments[0] || null, previous: assessments[1] || null, trend: assessments.slice().reverse() });
}

export async function createFitnessAssessment(req, res) {
  const filter = await scope(req);
  const values = fitnessValues(req.body || {});
  const item = await FitnessAssessment.create({ ...filter, ...values, recordedBy: { id: req.user._id, name: req.user.name } });
  return successResponse(res, 'Fitness assessment recorded.', publicAssessment(item), null, null, 201);
}

export async function correctFitnessAssessment(req, res) {
  const filter = { ...await scope(req), _id: objectId(req.params.assessmentId, 'Assessment') };
  const body = req.body || {};
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw new HttpError(400, 'A valid assessment revision is required.');
  const values = fitnessValues(body);
  const reason = text(body.correctionReason, 'Correction reason', 2, 300);
  const previous = await FitnessAssessment.findOne(filter);
  if (!previous) throw new HttpError(404, 'Fitness assessment not found.');
  if (previous.revision !== body.revision) throw new HttpError(409, 'This assessment was changed. Reload it before making a correction.');
  const item = await FitnessAssessment.findOneAndUpdate({ ...filter, revision: body.revision }, {
    $set: values, $inc: { revision: 1 }, $push: { corrections: {
      previous: fitnessSnapshot(previous), previousRevision: previous.revision,
      correctedBy: { id: req.user._id, name: req.user.name }, correctedAt: new Date(), reason,
    } },
  }, { returnDocument: 'after', runValidators: true });
  if (!item) throw new HttpError(409, 'This assessment was changed. Reload it before making a correction.');
  return successResponse(res, 'Assessment corrected. The previous values are retained in history.', publicAssessment(item));
}
