import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  userId: { type: Number, unique: true, index: true },
  username: String,
  inviteLink: String,             // unique channel invite link for this user
  invitedUsers: { type: [Number], default: [] }, // deduped list (for convenience)
  invitesCount: { type: Number, default: 0 },    // cached total
  rewardsClaimed: { type: [String], default: [] }, // rewardIds given
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('User', UserSchema);
