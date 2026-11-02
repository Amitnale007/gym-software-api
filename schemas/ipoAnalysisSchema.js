import mongoose from 'mongoose';

const ipoAnalysisSchema = new mongoose.Schema(
  {
    requested_close_date: {
      type: String,
      required: true,
      index: true,
    },

    market: {
      type: String,
      default: 'India',
    },

    ipo_type: {
      type: String,
      enum: ['all', 'mainboard', 'sme'],
      default: 'all',
    },

    ipo_count: {
      type: Number,
      required: true,
    },

    no_ipo_found: {
      type: Boolean,
      required: true,
    },

    data_as_of: {
      type: String,
      default: null,
    },

    // Complete JSON response from the AI
    result: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

ipoAnalysisSchema.index({
  requested_close_date: 1,
  createdAt: -1,
});

export default ipoAnalysisSchema;