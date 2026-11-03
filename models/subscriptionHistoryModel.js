import mongoose from 'mongoose';
import subscriptionSchema from '../schemas/gymSubscriptionSchema.js';

const historySchema = new mongoose.Schema({
  gym: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true, index: true },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, enum: ['Assigned', 'Changed', 'Renewed', 'Cancelled'], required: true },
  subscription: { type: subscriptionSchema, required: true },
  previousSubscription: { type: subscriptionSchema, default: null },
  periodStartsOn: { type: String, required: true },
  periodExpiresOn: { type: String, required: true },
}, { timestamps: true });
historySchema.index({ gym: 1, createdAt: -1 });

export default mongoose.model('SubscriptionHistory', historySchema);
