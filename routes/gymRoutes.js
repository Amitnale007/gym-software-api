import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { createGym, listGyms, myGym } from '../controllers/gymController.js';
import { manageSubscription, subscriptionHistory } from '../controllers/gymSubscriptionController.js';

const router = Router();
router.use(authenticate);
router.get('/mine', authorize('GYMADMIN', 'TRAINER', 'MEMBER'), myGym);
router.get('/', authorize('SUPERADMIN'), listGyms);
router.post('/', authorize('SUPERADMIN'), createGym);
router.patch('/:id/subscription', authorize('SUPERADMIN'), manageSubscription);
router.get('/:id/subscription/history', authorize('SUPERADMIN'), subscriptionHistory);

export default router;
