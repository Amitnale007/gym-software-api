import mongoose from 'mongoose';
import membership from '../schemas/memberMembershipSchema.js';

const schema = new mongoose.Schema({
  gym: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true },
  member: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  action: { type: String, enum: ['Joined', 'Renewed', 'Changed'], required: true },
  membership: { type: membership, required: true },
  previousMembership: { type: membership, default: null },
  closedAt: { type: Date, default: null },
  closedOn: { type: String, default: null },
  closureReason: { type: String, enum: ['Replaced', null], default: null },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ gym: 1, member: 1, createdAt: -1 });
export default mongoose.model('MemberHistory', schema);
