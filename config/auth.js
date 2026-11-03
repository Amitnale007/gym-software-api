import jwt from 'jsonwebtoken';

export const JWT_OPTIONS = { algorithm: 'HS256', issuer: 'gym-software-api', audience: 'gym-management' };

export function validateAuthConfig() {
  const access = process.env.JWT_ACCESS_SECRET;
  const refresh = process.env.JWT_REFRESH_SECRET;
  if (!access || !refresh || Buffer.byteLength(access) < 32 || Buffer.byteLength(refresh) < 32 || access === refresh) {
    throw new Error('Set different JWT_ACCESS_SECRET and JWT_REFRESH_SECRET values of at least 32 bytes in .env.');
  }
  for (const [secret, expiresIn] of [[access, process.env.JWT_ACCESS_EXPIRES_IN || '15m'], [refresh, process.env.JWT_REFRESH_EXPIRES_IN || '7d']]) {
    const token = jwt.sign({ type: 'configuration-check' }, secret, { ...JWT_OPTIONS, expiresIn });
    const claims = jwt.decode(token);
    if (claims.exp <= claims.iat) throw new Error('JWT validity must be positive.');
  }
}
