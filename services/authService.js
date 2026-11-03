import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { JWT_OPTIONS } from '../config/auth.js';
import Session from '../models/sessionModel.js';
import { publicUser } from '../utils/validation.js';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function verifyToken(token, type) {
  const secret = type === 'access' ? process.env.JWT_ACCESS_SECRET : process.env.JWT_REFRESH_SECRET;
  const claims = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: JWT_OPTIONS.issuer, audience: JWT_OPTIONS.audience });
  if (claims.type !== type || !mongoose.isValidObjectId(claims.sub) || !mongoose.isValidObjectId(claims.sid)) {
    throw new Error('Invalid token.');
  }
  return claims;
}

export function issueTokens(user, sessionId) {
  const payload = { sub: String(user._id), sid: String(sessionId) };
  const accessToken = jwt.sign({ ...payload, type: 'access' }, process.env.JWT_ACCESS_SECRET, {
    ...JWT_OPTIONS, expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m', jwtid: randomUUID(),
  });
  const refreshToken = jwt.sign({ ...payload, type: 'refresh' }, process.env.JWT_REFRESH_SECRET, {
    ...JWT_OPTIONS, expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d', jwtid: randomUUID(),
  });
  return { accessToken, refreshToken, user: publicUser(user) };
}

export async function createSession(user) {
  const sessionId = new mongoose.Types.ObjectId();
  const result = issueTokens(user, sessionId);
  await Session.create({
    _id: sessionId, user: user._id, refreshHash: hashToken(result.refreshToken),
    expiresAt: new Date(jwt.decode(result.refreshToken).exp * 1000),
  });
  return result;
}
