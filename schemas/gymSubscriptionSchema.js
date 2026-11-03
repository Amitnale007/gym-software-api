import mongoose from 'mongoose';

// Snapshot the purchased terms so later master edits do not change existing subscriptions.
export default new mongoose.Schema({
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
  planName: { type: String, required: true },
  pricePaise: { type: Number, required: true, min: 0 },
  code: { type: String, default: '' },
  pricing: { type: String, enum: ['FIXED', 'PER_MEMBER', 'PER_EMPLOYEE'], default: 'FIXED' },
  pricePerMemberPaise: { type: Number, min: 0, default: 0 },
  // Keep older subscription rates readable without rewriting history.
  pricePerEmployeePaise: { type: Number, min: 0 },
  currency: { type: String, enum: ['INR'], default: 'INR' },
  durationDays: { type: Number, required: true, min: 1 },
  startsOn: { type: String, required: true },
  expiresOn: { type: String, required: true },
  state: { type: String, enum: ['Active', 'Cancelled'], default: 'Active' },
}, { _id: false });
