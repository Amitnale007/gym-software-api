import User from '../models/userModel.js';
import Session from '../models/sessionModel.js';
import Gym from '../models/gymModel.js';
import { verifyToken } from '../services/authService.js';
import { HttpError } from '../utils/validation.js';

export async function assertActiveGym(user) {
  if (user.isActive === false) throw new HttpError(403, 'Your account is inactive. Contact your Gym Admin.');
  // Compatibility for previously saved customer accounts; startup also migrates them.
  if (user.role === 'GYM_CUSTOMER') user.role = 'MEMBER';
  if (user.role !== 'SUPERADMIN' && !await Gym.exists({ _id: user.gym, status: 'Active' })) {
    throw new HttpError(403, 'Your gym is unavailable. Contact the Superadmin.');
  }
}

export async function authenticate(req, res, next) {
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  let claims;
  try { claims = verifyToken(token, 'access'); }
  catch { throw new HttpError(401, 'Session expired. Please sign in again.'); }
  const [user, session] = await Promise.all([
    User.findById(claims.sub),
    Session.exists({ _id: claims.sid, user: claims.sub, expiresAt: { $gt: new Date() } }),
  ]);
  if (!user || !session) throw new HttpError(401, 'Session expired. Please sign in again.');
  await assertActiveGym(user);
  req.user = user;
  req.sessionId = claims.sid;
  next();
}

export const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) throw new HttpError(403, 'Your role does not have permission for this action.');
  next();
};
