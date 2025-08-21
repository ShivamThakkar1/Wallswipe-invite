import mongoose from 'mongoose';

const RewardSchema = new mongoose.Schema({
  rewardId: { type: String, unique: true, index: true }, // "1","2","3",...
  fileId: { type: String, required: true },              // Telegram file_id of ZIP
  threshold: { type: Number, required: true },           // e.g. 5,10,15...
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Reward', RewardSchema);
