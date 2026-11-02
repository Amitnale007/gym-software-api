import mongoose from "mongoose";

const dbConnect = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      autoIndex: true,
    });
    console.log("MongoDB connected:", mongoose.connection.name);
  } catch (err) {
    console.error("DB Connection failed:", err.message);
    process.exit(1);
  }
};

export default dbConnect;