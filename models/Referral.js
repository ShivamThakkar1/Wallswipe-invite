import mongoose from 'mongoose';

// Ensures a joinedUserId is only ever counted once globally.
const ReferralSchema = new mongoose.Schema({
  joinedUserId: { type: Number, unique: true, index: true },
  inviterUserId: { type: Number, index: true },
  chatId: { type: Number },            // channel id (numeric)
  date: { type: Date, default: Date.now }
});

export default mongoose.model('Referral', ReferralSchema);
