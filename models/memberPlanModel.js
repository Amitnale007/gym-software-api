import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  gym: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  nameKey: { type: String, required: true },
  code: { type: String, trim: true, uppercase: true, default: '', maxlength: 30 },
  description: { type: String, default: '', maxlength: 500 },
  pricePaise: { type: Number, required: true, min: 0, max: 1_000_000_000, validate: Number.isSafeInteger },
  durationMonths: { type: Number, min: 1, max: 12, validate: Number.isInteger },
  durationDays: { type: Number, min: 1 }, // Legacy plans remain readable until edited.
  isActive: { type: Boolean, default: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ gym: 1, nameKey: 1 }, { unique: true });
export default mongoose.model('MemberPlan', schema);
