import { publicSubscription } from './subscription.js';
import { HttpError } from './httpError.js';
export { HttpError } from './httpError.js';

export function text(value, label, min = 1, max = 120) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new HttpError(400, `${label} must contain ${min} to ${max} characters.`);
  }
  return value.trim();
}

export function email(value, label = 'Email') {
  const result = text(value, label, 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpError(400, `${label} must be a valid email address.`);
  return result;
}

export function password(value, min = 8) {
  // bcrypt considers only the first 72 bytes. Reject longer inputs instead of truncating.
  if (typeof value !== 'string' || value.length < min || Buffer.byteLength(value, 'utf8') > 72) {
    throw new HttpError(400, `Password must contain at least ${min} characters and at most 72 UTF-8 bytes.`);
  }
  return value;
}

export function publicUser(user) {
  return { id: String(user._id), name: user.name, email: user.email, role: user.role, gymId: user.gym ? String(user.gym) : null };
}

export function publicGym(gym) {
  const value = gym.toObject ? gym.toObject() : gym;
  return {
    id: String(value._id), name: value.name, email: value.email, phone: value.phone,
    address: value.address, city: value.city, status: value.status, createdAt: value.createdAt,
    admin: value.admin?.name ? publicUser(value.admin) : null,
    subscription: publicSubscription(value.subscription), subscriptionRevision: value.subscriptionRevision || 0,
  };
}
