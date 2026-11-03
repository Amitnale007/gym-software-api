import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['SUPERADMIN', 'GYMADMIN', 'TRAINER', 'MEMBER'], required: true },
    isActive: { type: Boolean, default: true },
    gym: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Gym', default: null, index: true,
      required() { return this.role !== 'SUPERADMIN'; },
    },
  },
  {
    timestamps: true,
  }
);

export default userSchema;
