import mongoose from "mongoose";
import dns from 'node:dns';

const dbConnect = async () => {
    if (process.env.DNS_SERVERS?.trim()) {
      dns.setServers(process.env.DNS_SERVERS.split(',').map((server) => server.trim()).filter(Boolean));
    }
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required in .env.');
    await mongoose.connect(process.env.MONGODB_URI, {
      autoIndex: true,
      serverSelectionTimeoutMS: 10000,
    });
    console.log("MongoDB connected:", mongoose.connection.name);
};

export default dbConnect;
