import 'dotenv/config';
import app from './app.js';
import dbConnect from './config/dbConnect.js';
import { validateAuthConfig } from './config/auth.js';
import User from './models/userModel.js';
import Gym from './models/gymModel.js';
import Session from './models/sessionModel.js';
import mongoose from 'mongoose';
import SubscriptionPlan from './models/subscriptionPlanModel.js';
import SubscriptionHistory from './models/subscriptionHistoryModel.js';
import MemberPlan from './models/memberPlanModel.js';
import Member from './models/memberModel.js';
import MemberHistory from './models/memberHistoryModel.js';
import MemberCounter from './models/memberCounterModel.js';
import { backfillMemberNumbers } from './services/memberNumberService.js';

const startServer = async () => {
  try {
    validateAuthConfig();
    await dbConnect();
    await Promise.all([User.init(), Gym.init(), Session.init(), SubscriptionPlan.init(), SubscriptionHistory.init(), MemberPlan.init(), Member.init(), MemberHistory.init(), MemberCounter.init()]);
    await backfillMemberNumbers();
    await User.updateMany({ role: 'GYM_CUSTOMER' }, { $set: { role: 'MEMBER' } });

    const [host, port] = (
      process.env.AWS_LAMBDA_HTTP_ENDPOINT ||
      `127.0.0.1:${process.env.PORT || 3000}`
    ).split(':');

    app.listen(Number(port), host, () => {
      console.log(`Server running at http://${host}:${port}`);
    });
  } catch (error) {
    console.error('Server startup failed:', error.message);
    await mongoose.disconnect();
    process.exitCode = 1;
  }
};

startServer();
