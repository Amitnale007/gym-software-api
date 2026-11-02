import User from '../models/userModel.js';
import {
  successResponse,
  errorResponse,
} from '../utils/response.js';

export const createUser = async (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name?.trim() || !email?.trim()) {
      return errorResponse(
        res,
        'Name and email are required',
        {},
        400
      );
    }

    const user = await User.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
    });

    return successResponse(
      res,
      'User created successfully',
      user,
      null,
      null,
      201
    );
  } catch (error) {
    if (error.code === 11000) {
      return errorResponse(
        res,
        'Email already exists',
        {},
        409
      );
    }

    if (error.name === 'ValidationError') {
      return errorResponse(
        res,
        'Invalid user data',
        {},
        400
      );
    }

    console.error('Create user error:', error.message);

    return errorResponse(res);
  }
};

export const getUsers = async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });

    return successResponse(
      res,
      'Users fetched successfully',
      users
    );
  } catch (error) {
    console.error('Get users error:', error.message);
    return errorResponse(res);
  }
};