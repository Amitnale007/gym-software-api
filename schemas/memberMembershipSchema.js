import mongoose from 'mongoose';

export default new mongoose.Schema({
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'MemberPlan', required: true },
  planName: { type: String, required: true },
  pricePaise: { type: Number, required: true, min: 0 },
  durationMonths: { type: Number, min: 1, max: 12 },
  durationDays: { type: Number, min: 1 }, // Preserve existing day-based history.
  startsOn: { type: String, required: true },
  expiresOn: { type: String, required: true },
}, { _id: false });
