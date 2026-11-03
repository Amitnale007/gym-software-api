import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Gym from '../models/gymModel.js';
import User from '../models/userModel.js';
import { email, HttpError, password, publicGym, text } from '../utils/validation.js';
import { successResponse } from '../utils/response.js';
import { assignedSubscription, recordSubscriptionChange } from '../services/subscriptionService.js';

export async function listGyms(req, res) {
  const gyms = await Gym.find().populate('admin', 'name email role gym').sort({ createdAt: -1 });
  return successResponse(res, 'Gyms loaded.', gyms.map(publicGym));
}

export async function createGym(req, res) {
  const body = req.body || {};
  const values = {
    name: text(body.name, 'Gym name', 2, 120), email: email(body.email, 'Gym email'),
    phone: text(body.phone, 'Phone', 7, 20), address: text(body.address ?? '', 'Address', 0, 300),
    city: text(body.city ?? '', 'City', 0, 100),
  };
  if (!/^\+?[\d ()-]{7,20}$/.test(values.phone)) throw new HttpError(400, 'Enter a valid phone number.');
  const adminName = text(body.adminName, 'Gymadmin name', 2, 80);
  const adminEmail = email(body.adminEmail, 'Gymadmin email');
  const adminPassword = password(body.adminPassword);
  if (await User.exists({ email: adminEmail })) throw new HttpError(409, 'An account with this Gymadmin email already exists.');
  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const gymId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();
  // A transaction saves both the gym and its admin, or neither.
  await mongoose.connection.transaction(async (session) => {
    const subscription = await assignedSubscription(body.planId, body.startsOn, session);
    await User.create([{
      _id: adminId, name: adminName, email: adminEmail, passwordHash, role: 'GYMADMIN', gym: gymId,
    }], { session });
    await Gym.create([{
      _id: gymId, ...values, admin: adminId, createdBy: req.user._id, subscription, subscriptionRevision: 1,
    }], { session });
    await recordSubscriptionChange({ gym: gymId, actor: req.user._id, action: 'Assigned', subscription }, session);
  });
  const gym = await Gym.findById(gymId).populate('admin', 'name email role gym');
  return successResponse(res, 'Gym and Gymadmin account created.', publicGym(gym), null, null, 201);
}

export async function myGym(req, res) {
  const gym = await Gym.findById(req.user.gym).populate('admin', 'name email role gym');
  if (!gym) throw new HttpError(404, 'Gym not found.');
  return successResponse(res, 'Your gym loaded.', publicGym(gym));
}
