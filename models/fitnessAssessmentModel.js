import mongoose from 'mongoose';
import { bodyFatMethods, measurementLimits } from '../utils/fitness.js';

const values = {
  assessedOn: { type: String, required: true },
  ...Object.fromEntries(Object.entries(measurementLimits).map(([field, [, min, max]]) => [field, {
    type: Number, min, max, required: field === 'heightCm' || field === 'weightKg', default: null,
  }])),
  bmi: { type: Number, required: true },
  bodyFatMethod: { type: String, enum: ['', ...bodyFatMethods], default: '' },
  notes: { type: String, maxlength: 1000, default: '' },
  goals: { type: String, maxlength: 500, default: '' },
};
const actor = new mongoose.Schema({
  id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
}, { _id: false });
const correction = new mongoose.Schema({
  previous: { type: new mongoose.Schema(values, { _id: false }), required: true },
  previousRevision: { type: Number, required: true },
  correctedBy: { type: actor, required: true },
  correctedAt: { type: Date, required: true },
  reason: { type: String, required: true, maxlength: 300 },
}, { _id: false });
const schema = new mongoose.Schema({
  gym: { type: mongoose.Schema.Types.ObjectId, ref: 'Gym', required: true },
  member: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  ...values,
  recordedBy: { type: actor, required: true },
  revision: { type: Number, default: 0 },
  corrections: { type: [correction], default: [] },
}, { timestamps: true });
schema.index({ gym: 1, member: 1, assessedOn: -1, createdAt: -1, _id: -1 });
export default mongoose.model('FitnessAssessment', schema);
