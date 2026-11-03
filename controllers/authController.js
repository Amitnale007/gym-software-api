import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/userModel.js';
import Session from '../models/sessionModel.js';
import { assertActiveGym } from '../middleware/auth.js';
import { createSession, hashToken, issueTokens, verifyToken } from '../services/authService.js';
import { email, HttpError, password, publicUser } from '../utils/validation.js';
import { successResponse } from '../utils/response.js';

const dummyHash = bcrypt.hashSync('unused-login-comparison', 12);

export async function login(req, res) {
  const loginEmail = email(req.body?.email);
  const loginPassword = password(req.body?.password, 1);
  const user = await User.findOne({ email: loginEmail }).select('+passwordHash');
  const valid = await bcrypt.compare(loginPassword, user?.passwordHash || dummyHash);
  if (!user || !valid) throw new HttpError(401, 'Email or password is incorrect.');
  await assertActiveGym(user);
  return successResponse(res, 'Welcome back!', await createSession(user));
}

export async function refresh(req, res) {
  const token = req.body?.refreshToken;
  let claims;
  try { claims = verifyToken(token, 'refresh'); }
  catch { throw new HttpError(401, 'Session expired. Please sign in again.'); }
  const user = await User.findById(claims.sub);
  if (!user) throw new HttpError(401, 'Session expired. Please sign in again.');
  await assertActiveGym(user);
  const result = issueTokens(user, claims.sid);
  // Compare-and-swap prevents reuse of an already rotated refresh token.
  const session = await Session.findOneAndUpdate({
    _id: claims.sid, user: user._id, refreshHash: hashToken(token), expiresAt: { $gt: new Date() },
  }, {
    $set: { refreshHash: hashToken(result.refreshToken), expiresAt: new Date(jwt.decode(result.refreshToken).exp * 1000) },
  });
  if (!session) throw new HttpError(401, 'Session expired. Please sign in again.');
  return successResponse(res, 'Session refreshed.', result);
}

export async function logout(req, res) {
  await Session.deleteOne({ _id: req.sessionId, user: req.user._id });
  return successResponse(res, 'Signed out.', null);
}

export function me(req, res) { return successResponse(res, 'Account loaded.', publicUser(req.user)); }
