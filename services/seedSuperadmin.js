import bcrypt from 'bcryptjs';
import User from '../models/userModel.js';
import { email, password, text } from '../utils/validation.js';

export default async function seedSuperadmin({ email: inputEmail, password: inputPassword, name = 'Superadmin' } = {}) {
  const adminEmail = email(inputEmail);
  const existing = await User.findOne({ email: adminEmail });
  if (existing) {
    if (existing.role !== 'SUPERADMIN') throw new Error('This email belongs to another account.');
    return existing; // Setup never resets an existing account or password.
  }
  const passwordHash = await bcrypt.hash(password(inputPassword, 8), 12);
  try {
    return await User.create({
      name: text(name, 'Superadmin name', 2, 80),
      email: adminEmail, passwordHash, role: 'SUPERADMIN', gym: null,
    });
  } catch (error) {
    if (error.code === 11000) {
      const created = await User.findOne({ email: adminEmail, role: 'SUPERADMIN' });
      if (created) return created;
    }
    throw error;
  }
}
