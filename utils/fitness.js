import { dateOnly, todayInIndia } from './subscription.js';
import { HttpError, text } from './validation.js';

export const measurementLimits = {
  heightCm: ['Height', 30, 300], weightKg: ['Weight', 1, 700],
  bodyFatPercent: ['Body fat percentage', 0.1, 99.9],
  chestCm: ['Chest', 0.1, 400], waistCm: ['Waist', 0.1, 400],
  leftArmCm: ['Left arm', 0.1, 200], rightArmCm: ['Right arm', 0.1, 200],
  leftThighCm: ['Left thigh', 0.1, 300], rightThighCm: ['Right thigh', 0.1, 300],
};
export const bodyFatMethods = ['bioimpedance', 'skinfold', 'dexa', 'other'];
export const fitnessValueKeys = ['assessedOn', ...Object.keys(measurementLimits), 'bodyFatMethod', 'notes', 'goals', 'bmi'];

export function calculateBmi(heightCm, weightKg) {
  if (!Number.isFinite(heightCm) || !Number.isFinite(weightKg) || heightCm <= 0 || weightKg <= 0) return null;
  return Math.round(weightKg / (heightCm / 100) ** 2 * 10) / 10;
}

export function fitnessValues(body) {
  const assessedOn = dateOnly(body.assessedOn, 'Assessment date');
  if (assessedOn > todayInIndia()) throw new HttpError(400, 'Assessment date cannot be in the future.');
  const values = { assessedOn };
  for (const [field, [label, min, max]] of Object.entries(measurementLimits)) {
    const value = body[field];
    if (value == null && field !== 'heightCm' && field !== 'weightKg') { values[field] = null; continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new HttpError(400, `${label} must be a number from ${min} to ${max}.`);
    values[field] = value;
  }
  const method = body.bodyFatMethod ?? '';
  if (values.bodyFatPercent !== null && !bodyFatMethods.includes(method)) throw new HttpError(400, 'Select how body fat was measured.');
  if (values.bodyFatPercent === null && method !== '') throw new HttpError(400, 'Enter a body fat percentage for the selected method.');
  values.bodyFatMethod = method;
  values.notes = text(body.notes ?? '', 'Trainer notes', 0, 1000);
  values.goals = text(body.goals ?? '', 'Fitness goals', 0, 500);
  values.bmi = calculateBmi(values.heightCm, values.weightKg);
  return values;
}

export function fitnessSnapshot(assessment) {
  return Object.fromEntries(fitnessValueKeys.map((key) => [key, assessment[key]]));
}
