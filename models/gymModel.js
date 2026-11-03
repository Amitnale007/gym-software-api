import mongoose from 'mongoose';
import subscriptionSchema from '../schemas/gymSubscriptionSchema.js';

const gymSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, required: true, trim: true },
  address: { type: String, default: '', trim: true, maxlength: 300 },
  city: { type: String, default: '', trim: true, maxlength: 100 },
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  subscription: { type: subscriptionSchema, default: null },
  subscriptionRevision: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

export default mongoose.model('Gym', gymSchema);
