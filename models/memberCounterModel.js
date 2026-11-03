import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true },
  value: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  prefix: { type: String, default: 'MEM', match: /^[A-Z]{1,10}$/ },
  padding: { type: Number, default: 4, min: 1, max: 8, validate: Number.isInteger },
  settingsRevision: { type: Number, default: 0, min: 0 },
}, { versionKey: false });
export default mongoose.model('MemberCounter', schema);
