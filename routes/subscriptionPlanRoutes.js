import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { createPlan, listPlans, updatePlan, removePlan } from '../controllers/subscriptionPlanController.js';

const router = Router();
router.use(authenticate, authorize('SUPERADMIN'));
router.get('/', listPlans);
router.post('/', createPlan);
router.patch('/:id', updatePlan);
router.delete('/:id', removePlan);

export default router;
