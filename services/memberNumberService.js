import mongoose from 'mongoose';
import Member from '../models/memberModel.js';
import Counter from '../models/memberCounterModel.js';

export const memberCode = (number, prefix = 'MEM', padding = 4) => Number.isSafeInteger(number) && number > 0 ? `${prefix}${String(number).padStart(padding, '0')}` : 'Pending ID';

export async function ensureMemberCounter(gym) {
  const highest = await Member.findOne({ gym, memberNumber: { $gt: 0 } }).sort({ memberNumber: -1 }).select('memberNumber').lean();
  const update = { $max: { value: highest?.memberNumber || 0 } };
  try { await Counter.updateOne({ _id: gym }, update, { upsert: true }); }
  catch (error) {
    if (error.code !== 11000) throw error;
    await Counter.updateOne({ _id: gym }, update);
  }
  const stored = await Counter.findById(gym).lean();
  for (const [field, fallback] of Object.entries({ prefix: 'MEM', padding: 4, settingsRevision: 0 })) {
    if (stored[field] == null) await Counter.updateOne({ _id: gym, [field]: null }, { $set: { [field]: fallback } });
  }
}

export async function nextMemberNumber(gym, session) {
  const counter = await Counter.findOneAndUpdate({ _id: gym }, { $inc: { value: 1 } }, { session, returnDocument: 'after' });
  if (!counter || !Number.isSafeInteger(counter.value)) throw new Error('Member numbering is unavailable.');
  return { memberNumber: counter.value, memberCode: memberCode(counter.value, counter.prefix, counter.padding) };
}

export async function backfillMemberNumbers() {
  const cursor = Member.find({ $or: [{ memberNumber: null }, { memberCode: null }] }).sort({ createdAt: 1, _id: 1 }).select('_id gym').lean().cursor();
  for await (const candidate of cursor) {
    await ensureMemberCounter(candidate.gym);
    await mongoose.connection.transaction(async (session) => {
      const missing = await Member.findOne({ _id: candidate._id, $or: [{ memberNumber: null }, { memberCode: null }] }).session(session);
      if (!missing) return;
      const counter = missing.memberNumber ? await Counter.findById(candidate.gym).session(session) : null;
      const values = missing.memberNumber ? { memberNumber: missing.memberNumber, memberCode: memberCode(missing.memberNumber, counter.prefix, counter.padding) } : await nextMemberNumber(candidate.gym, session);
      await Member.updateOne({ _id: candidate._id }, { $set: values }).session(session);
    });
  }
}
