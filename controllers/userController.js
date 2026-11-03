import bcrypt from 'bcryptjs';
import User from '../models/userModel.js';
import { email, password, publicUser, text } from '../utils/validation.js';
import { successResponse } from '../utils/response.js';

// Compatibility endpoint: Gym Admins can create member logins only in their own gym.
// Ignore client-supplied roles and gym IDs to prevent privilege escalation.
export async function createUser(req, res) {
  const body = req.body || {};
  const user = await User.create({
    name: text(body.name, 'Name', 2, 80), email: email(body.email),
    passwordHash: await bcrypt.hash(password(body.password), 12),
    role: 'MEMBER', gym: req.user.gym,
  });
  return successResponse(res, 'Member account created.', publicUser(user), null, null, 201);
}

export async function getUsers(req, res) {
  const filter = req.user.role === 'SUPERADMIN' ? {} : { gym: req.user.gym };
  const users = await User.find(filter).sort({ createdAt: -1 });
  return successResponse(res, 'Users loaded.', users.map(publicUser));
}
