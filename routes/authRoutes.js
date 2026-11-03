import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { login, logout, me, refresh } from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});
router.post('/login', loginLimit, login);
router.post('/refresh-token', rateLimit({ windowMs: 60_000, limit: 60, legacyHeaders: false }), refresh);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, me);

export default router;
