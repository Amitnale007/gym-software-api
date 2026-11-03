import mongoose from 'mongoose';

const planSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  nameKey: { type: String, required: true, unique: true },
  code: { type: String, trim: true, uppercase: true, default: '', maxlength: 30 },
  pricing: { type: String, enum: ['FIXED', 'PER_MEMBER', 'PER_EMPLOYEE'], default: 'FIXED' },
  pricePerMemberPaise: { type: Number, min: 0, max: 1_000_000_000, default: 0, validate: Number.isSafeInteger },
  // Read compatibility for plans saved before member pricing was introduced.
  pricePerEmployeePaise: { type: Number, min: 0 },
  archivedAt: { type: Date, default: null },
  description: { type: String, trim: true, default: '', maxlength: 500 },
  pricePaise: { type: Number, required: true, min: 0, max: 1_000_000_000, validate: Number.isSafeInteger },
  currency: { type: String, enum: ['INR'], default: 'INR' },
  durationDays: { type: Number, required: true, min: 1, max: 3650, validate: Number.isInteger },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

export default mongoose.model('SubscriptionPlan', planSchema);
