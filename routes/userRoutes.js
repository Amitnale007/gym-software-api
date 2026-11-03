import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import {
  createUser,
  getUsers,
} from '../controllers/userController.js';

const router = Router();

router.use(authenticate);
router.post('/', authorize('GYMADMIN'), createUser);
router.get('/', authorize('SUPERADMIN', 'GYMADMIN'), getUsers);

export default router;
