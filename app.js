import express from 'express';
import cors from 'cors';
import userRoutes from './routes/userRoutes.js';
import authRoutes from './routes/authRoutes.js';
import gymRoutes from './routes/gymRoutes.js';
import subscriptionPlanRoutes from './routes/subscriptionPlanRoutes.js';
import memberManagementRoutes from './routes/memberManagementRoutes.js';
import { errorResponse } from './utils/response.js';

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
app.use(express.json({ limit: '32kb', inflate: false }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.use('/api/auth', authRoutes);
app.use('/api/gyms', gymRoutes);
app.use('/api/subscription-plans', subscriptionPlanRoutes);
app.use('/api/users', userRoutes);
app.use('/api', memberManagementRoutes);
app.use((req, res) => errorResponse(res, 'Endpoint not found.', {}, 404));
app.use((error, req, res, next) => {
  if (error.code === 11000) return errorResponse(res, error.keyPattern?.nameKey ? 'A subscription plan with this name already exists.' : 'An account with this email already exists.', {}, 409);
  if (error.name === 'ValidationError' || error.name === 'CastError') return errorResponse(res, 'Invalid data.', {}, 400);
  const status = error.status || 500;
  if (status >= 500) console.error('API request failed:', error.name);
  return errorResponse(res, status < 500 ? error.message : 'Unable to complete the request.', {}, status);
});

export default app;
