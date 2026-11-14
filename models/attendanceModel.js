import mongoose from 'mongoose';

const actor = new mongoose.Schema({ id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, name: { type: String, required: true } }, { _id: false });
const schema = new mongoose.Schema({
  gym: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true },
  member: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  memberName: { type: String, required: true }, memberCode: { type: String, required: true },
  checkedInAt: { type: Date, required: true }, checkedOutAt: { type: Date, default: null },
  checkInSource: { type: String, enum: ['self', 'manual', 'qr'], required: true },
  checkOutSource: { type: String, enum: ['self', 'manual', 'qr', null], default: null },
  checkedInBy: { type: actor, required: true }, checkedOutBy: { type: actor, default: null },
}, { timestamps: true });
// Database enforcement complements the transaction lock: at most one open visit per member.
schema.index({ gym: 1, member: 1 }, { unique: true, partialFilterExpression: { checkedOutAt: null }, name: 'one_open_visit_per_member' });
schema.index({ gym: 1, checkedInAt: -1 });
schema.index({ gym: 1, member: 1, checkedInAt: -1 });
schema.index({ gym: 1, checkedOutAt: 1 });
export default mongoose.model('Attendance', schema);
