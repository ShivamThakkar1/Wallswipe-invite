import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { connectDB } from './db.js';
import User from './models/User.js';
import Reward from './models/Reward.js';
import Referral from './models/Referral.js';

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; // '@wallswipe' or numeric -100...
const ADMIN_ID = Number(process.env.ADMIN_ID);
const INVITES_PER_REWARD = Number(process.env.INVITES_PER_REWARD || 5);
const LEADERBOARD_SIZE = Number(process.env.LEADERBOARD_SIZE || 10);

if (!BOT_TOKEN || !CHANNEL_ID || !process.env.MONGO_URI || !ADMIN_ID) {
  console.error('❌ Missing required env. Please set BOT_TOKEN, CHANNEL_ID, MONGO_URI, ADMIN_ID');
  process.exit(1);
}

// For channel id numeric handling: Telegraf wants numbers for some methods.
function normalizeChatId(id) {
  if (typeof id === 'string' && id.startsWith('@')) return id; // public
  if (typeof id === 'string') return Number(id);
  return id;
}
const CHANNEL_CHAT_ID = normalizeChatId(CHANNEL_ID);

// ====== BOOT ======
await connectDB(process.env.MONGO_URI);
const bot = new Telegraf(BOT_TOKEN, {
  handlerTimeout: 90_000
});

// Simple in-memory state for /reward uploads
const pendingRewardUploads = new Map(); // adminId -> { rewardId, threshold }

// ====== HELPERS ======
async function ensureUser(ctxFrom) {
  const { id: userId, username } = ctxFrom;
  let user = await User.findOne({ userId });
  if (!user) {
    user = await User.create({ userId, username });
  } else if (user.username !== username) {
    user.username = username;
    await user.save();
  }
  return user;
}

async function getOrCreateInviteLinkForUser(user) {
  if (user.inviteLink) return user.inviteLink;

  // create a personal invite link for the channel
  // requires bot to be admin of the channel with "Invite Users via Link" permission
  const link = await bot.telegram.createChatInviteLink(CHANNEL_CHAT_ID, {
    name: `u${user.userId}`,
    creates_join_request: false, // direct join
    member_limit: 0
  });

  user.inviteLink = link.invite_link;
  await user.save();
  return user.inviteLink;
}

function isAdmin(ctx) {
  return ctx.from && ctx.from.id === ADMIN_ID;
}

async function sendDueRewards(ctx, inviter) {
  // fetch all rewards sorted by threshold
  const rewards = await Reward.find().sort({ threshold: 1 });
  if (!rewards.length) return;

  // send all rewards whose threshold <= invitesCount and not yet claimed
  const toSend = rewards.filter(r => r.threshold <= inviter.invitesCount && !inviter.rewardsClaimed.includes(r.rewardId));

  for (const r of toSend) {
    try {
      await ctx.telegram.sendDocument(inviter.userId, r.fileId, { caption: `🎁 Reward #${r.rewardId} (Reached ${r.threshold} invites)` });
      inviter.rewardsClaimed.push(r.rewardId);
    } catch (e) {
      console.error('Failed to send reward', r.rewardId, e.message);
    }
  }
  if (toSend.length) await inviter.save();
}

function progressText(invites, step) {
  const next = Math.ceil((invites + 1) / step) * step;
  const done = invites % step;
  const left = step - done;
  return `You have **${invites}** invites.\nNext reward at **${next}** (only ${left} to go).`;
}

// ====== COMMANDS ======
bot.start(async (ctx) => {
  const user = await ensureUser(ctx.from);
  const link = await getOrCreateInviteLinkForUser(user);

  await ctx.replyWithMarkdown(
    `Hey **${ctx.from.first_name}**! 👋\n` +
    `Share your personal invite link to grow **@wallswipe** and earn ZIP rewards.\n\n` +
    `🔗 Your invite link:\n${link}\n\n` +
    `💡 Every ${INVITES_PER_REWARD} invites unlocks a new reward ZIP.\n` +
    `Use /myinvites to see your progress, /rewards to view unlocked rewards, /top for the leaderboard.`
  );
});

bot.command('link', async (ctx) => {
  const user = await ensureUser(ctx.from);
  const link = await getOrCreateInviteLinkForUser(user);
  await ctx.reply(`🔗 Your invite link:\n${link}`);
});

bot.command('myinvites', async (ctx) => {
  const user = await ensureUser(ctx.from);
  const text = `👤 @${user.username || user.userId}\n` +
               `Invites: ${user.invitesCount}\n` +
               progressText(user.invitesCount, INVITES_PER_REWARD);
  await ctx.replyWithMarkdown(text);
});

bot.command('rewards', async (ctx) => {
  const user = await ensureUser(ctx.from);
  if (!user.rewardsClaimed.length) {
    await ctx.reply('You haven’t unlocked any rewards yet. Keep inviting! 🚀');
    return;
  }
  await ctx.reply(`Unlocked rewards: ${user.rewardsClaimed.map(r => `#${r}`).join(', ')}`);
});

bot.command('top', async (ctx) => {
  const top = await User.find().sort({ invitesCount: -1 }).limit(LEADERBOARD_SIZE).lean();
  if (!top.length) return ctx.reply('No data yet.');
  const lines = top.map((u, i) => `${i + 1}. ${u.username ? '@' + u.username : u.userId} — ${u.invitesCount}`);
  await ctx.reply(`🏆 Top Inviters:\n` + lines.join('\n'));
});

// ====== ADMIN COMMANDS ======
bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const totalUsers = await User.countDocuments();
  const totalReferrals = await Referral.countDocuments();
  const activeInviters = await User.countDocuments({ invitesCount: { $gt: 0 } });
  await ctx.reply(`📊 Stats\nUsers: ${totalUsers}\nReferrals (unique joins): ${totalReferrals}\nActive inviters: ${activeInviters}`);
});

bot.command('user', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!arg) return ctx.reply('Usage: /user <id|@username>');
  let query = {};
  if (arg.startsWith('@')) query = { username: arg.slice(1) };
  else query = { userId: Number(arg) };

  const user = await User.findOne(query);
  if (!user) return ctx.reply('User not found.');
  await ctx.reply(
    `👤 ${user.username ? '@' + user.username : user.userId}\n` +
    `UserId: ${user.userId}\nInvites: ${user.invitesCount}\nClaimed: ${user.rewardsClaimed.join(', ') || 'none'}\n` +
    `Invite link: ${user.inviteLink || 'not generated'}\nInvited users: ${user.invitedUsers.length}`
  );
});

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const msg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!msg) return ctx.reply('Usage: /broadcast <message>');
  const users = await User.find({}, { userId: 1 });
  let ok = 0, fail = 0;
  for (const u of users) {
    try {
      await ctx.telegram.sendMessage(u.userId, msg);
      ok++;
    } catch {
      fail++;
    }
  }
  await ctx.reply(`Broadcast done. ✅ ${ok} / ❌ ${fail}`);
});

bot.command('rewardslist', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rewards = await Reward.find().sort({ threshold: 1 });
  if (!rewards.length) return ctx.reply('No rewards saved.');
  const lines = rewards.map(r => `#${r.rewardId} → threshold ${r.threshold}`);
  await ctx.reply('🎁 Rewards:\n' + lines.join('\n'));
});

// /reward <id> [threshold]
// Then admin uploads a ZIP; bot captures file_id and saves Reward.
bot.command('reward', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Usage: /reward <id> [threshold]');
  const rewardId = parts[1];
  let threshold = Number(parts[2]);
  if (isNaN(threshold)) {
    // default to N * INVITES_PER_REWARD
    const asNum = Number(rewardId);
    threshold = Number.isFinite(asNum) ? asNum * INVITES_PER_REWARD : INVITES_PER_REWARD;
  }

  pendingRewardUploads.set(ctx.from.id, { rewardId, threshold });
  await ctx.reply(`Send the ZIP file for reward #${rewardId} (threshold ${threshold}).`);
});

// Capture uploaded ZIP after /reward
bot.on('document', async (ctx) => {
  if (!isAdmin(ctx)) return; // only admin uploads are accepted for rewards
  const pending = pendingRewardUploads.get(ctx.from.id);
  if (!pending) return; // not expecting a reward upload

  const doc = ctx.message.document;
  // Basic check for ZIP
  const isZip = (doc.mime_type && doc.mime_type.includes('zip')) || (doc.file_name && doc.file_name.toLowerCase().endsWith('.zip'));
  if (!isZip) return ctx.reply('Please send a ZIP file.');

  const fileId = doc.file_id;
  const { rewardId, threshold } = pending;

  await Reward.findOneAndUpdate(
    { rewardId },
    { rewardId, fileId, threshold },
    { upsert: true, new: true }
  );

  pendingRewardUploads.delete(ctx.from.id);
  await ctx.reply(`Saved reward #${rewardId} at threshold ${threshold}.`);
});

// ====== MEMBER / JOIN TRACKING ======
// We need chat_member updates to know who joined the channel and via which invite link.
bot.on('chat_member', async (ctx) => {
  const upd = ctx.update.chat_member;
  if (!upd) return;

  const chatId = upd.chat?.id;
  if (chatId !== (typeof CHANNEL_CHAT_ID === 'string' ? upd.chat?.username ? `@${upd.chat.username}` : chatId : CHANNEL_CHAT_ID)) {
    // For public channels, upd.chat.username yields @wallswipe style later;
    // normalize: if configured with @wallswipe, accept if matches username.
    if (typeof CHANNEL_CHAT_ID === 'string' && CHANNEL_CHAT_ID.startsWith('@')) {
      const uname = upd.chat?.username ? '@' + upd.chat.username : null;
      if (uname !== CHANNEL_ID) return;
    } else if (typeof CHANNEL_CHAT_ID === 'number') {
      if (chatId !== CHANNEL_CHAT_ID) return;
    }
  }

  const oldStatus = upd.old_chat_member?.status;
  const newStatus = upd.new_chat_member?.status;

  // We only care when a user *becomes* a member
  if (newStatus === 'member' && oldStatus !== 'member') {
    const joinedUser = upd.new_chat_member.user;
    const joinedUserId = joinedUser.id;

    // If joined via invite link, Telegram includes the invite_link used.
    const usedInviteLink = upd.invite_link?.invite_link; // string like https://t.me/+xxxx
    if (!usedInviteLink) {
      // Joined without a tracked personal link; ignore for referral purposes.
      return;
    }

    // Find which inviter this link belongs to
    const inviter = await User.findOne({ inviteLink: usedInviteLink });
    if (!inviter) return; // shouldn't happen but just in case

    // Anti-abuse: ignore self-invites
    if (inviter.userId === joinedUserId) return;

    // Enforce global uniqueness: only first time this user is counted
    try {
      await Referral.create({
        joinedUserId,
        inviterUserId: inviter.userId,
        chatId: typeof CHANNEL_CHAT_ID === 'number' ? CHANNEL_CHAT_ID : undefined
      });
    } catch (e) {
      // duplicate (already counted for someone) → ignore
      return;
    }

    // Update inviter stats (dedupe invitedUsers array)
    if (!inviter.invitedUsers.includes(joinedUserId)) {
      inviter.invitedUsers.push(joinedUserId);
    }
    inviter.invitesCount = inviter.invitedUsers.length;
    await inviter.save();

    // Notify inviter & send due rewards (DM)
    try {
      await ctx.telegram.sendMessage(inviter.userId, `🎉 New member joined via your link! Total invites: ${inviter.invitesCount}`);
      await sendDueRewards(ctx, inviter);
    } catch (err) {
      console.error('Failed to DM inviter or send reward:', err.message);
    }
  }
});

// ====== QUALITY OF LIFE ======
bot.command('help', (ctx) =>
  ctx.reply(
`🤖 Commands

Users:
  /start        → get your personal link + intro
  /link         → show your invite link
  /myinvites    → your invite count + next reward progress
  /rewards      → your unlocked rewards
  /top          → leaderboard

Admin:
  /stats                → overall stats
  /user <id|@username>  → inspect a user
  /rewardslist          → list all rewards
  /reward <id> [thr]    → save next uploaded ZIP as reward
  /broadcast <message>  → DM all users
`)
);

// ====== START (Long Polling) ======
bot.launch({
  allowedUpdates: ['message', 'chat_member', 'chat_join_request']
}).then(() => console.log('🤖 Bot launched (long polling)'))
  .catch(err => {
    console.error('Bot launch error:', err);
    process.exit(1);
  });

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
