import mongoose from 'mongoose';
import membership from '../schemas/memberMembershipSchema.js';

const schema = new mongoose.Schema({
  gym: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true, index: true },
  memberNumber: { type: Number, min: 1, validate: Number.isSafeInteger },
  memberCode: { type: String },
  name: { type: String, required: true, maxlength: 80 },
  phone: { type: String, required: true, maxlength: 20 },
  email: { type: String, default: '', maxlength: 254 },
  address: { type: String, default: '', maxlength: 300 },
  joinedOn: { type: String, required: true },
  trainer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isActive: { type: Boolean, default: true },
  deletedAt: { type: Date, default: null },
  membership: { type: membership, required: true },
  revision: { type: Number, default: 0 },
}, { timestamps: true });
schema.index({ gym: 1, trainer: 1 });
schema.index({ gym: 1, memberNumber: 1 }, { unique: true, partialFilterExpression: { memberNumber: { $type: 'number' } } });
schema.index({ gym: 1, memberCode: 1 }, { unique: true, partialFilterExpression: { memberCode: { $type: 'string' } } });
schema.index({ user: 1 }, { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } });
export default mongoose.model('Member', schema);
