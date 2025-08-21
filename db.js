import mongoose from 'mongoose';

export async function connectDB(uri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    dbName: 'wallswipe_invite_bot'
  });
  console.log('✅ MongoDB connected');
}
