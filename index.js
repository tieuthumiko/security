require('dotenv').config();
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  PermissionsBitField
} = require('discord.js');

const config = require('./config');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration
  ]
});

/* ================= EXPRESS (Render Keep Alive) ================= */

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.status(200).send('Security Bot Online');
});

app.listen(PORT, () => {
  console.log(`Web server running on ${PORT}`);
});

/* ================= TRACKERS ================= */

const spamTracker = new Map();
const joinTracker = new Map();
const actionTracker = new Map();

/* ================= HELPERS ================= */

function getLogChannel(guild) {
  return guild.channels.cache.find(
    c => c.name === config.LOG_CHANNEL_NAME
  );
}

function isWhitelisted(member) {
  if (!member) return false;

  if (config.WHITELIST_USERS.includes(member.id)) return true;

  return member.roles.cache.some(role =>
    config.WHITELIST_ROLES.includes(role.id)
  );
}

async function punish(member, reason, guild) {
  try {
    if (!member.moderatable) return;

    await member.timeout(config.TIMEOUT_DURATION, reason);

    getLogChannel(guild)?.send(
      `🚨 Punished <@${member.id}> | ${reason}`
    );
  } catch (err) {
    console.log("Punish error:", err.message);
  }
}

/* ================= READY ================= */

client.once('ready', () => {
  console.log(`🛡 Logged in as ${client.user.tag}`);
});

/* ================= ANTI SPAM ================= */

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;

  const member = message.member;
  if (!member || isWhitelisted(member)) return;

  const now = Date.now();
  const userId = member.id;

  if (!spamTracker.has(userId)) spamTracker.set(userId, []);
  spamTracker.get(userId).push(now);

  const recent = spamTracker.get(userId)
    .filter(t => now - t < config.SPAM_INTERVAL);

  spamTracker.set(userId, recent);

  if (recent.length >= config.SPAM_LIMIT) {
    await punish(member, "Spam detected", message.guild);
  }

  if (message.mentions.everyone) {
    await punish(member, "Mass mention detected", message.guild);
  }
});

/* ================= ANTI MASS JOIN ================= */

client.on('guildMemberAdd', member => {
  const guildId = member.guild.id;
  const now = Date.now();

  if (!joinTracker.has(guildId)) joinTracker.set(guildId, []);
  joinTracker.get(guildId).push(now);

  const recent = joinTracker.get(guildId)
    .filter(t => now - t < config.JOIN_INTERVAL);

  joinTracker.set(guildId, recent);

  if (recent.length >= config.JOIN_LIMIT) {
    getLogChannel(member.guild)?.send("Mass join detected!");
  }
});

/* ================= ANTI NUKE ================= */

async function checkAudit(guild, type) {
  try {
    const logs = await guild.fetchAuditLogs({
      limit: 1,
      type
    });

    const entry = logs.entries.first();
    if (!entry) return;

    const executor = entry.executor;
    if (!executor) return;

    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (!member) return;
    if (isWhitelisted(member)) return;

    const now = Date.now();

    if (!actionTracker.has(member.id))
      actionTracker.set(member.id, []);

    actionTracker.get(member.id).push(now);

    const recent = actionTracker.get(member.id)
      .filter(t => now - t < config.ACTION_INTERVAL);

    actionTracker.set(member.id, recent);

    if (recent.length >= config.ACTION_LIMIT) {
      await punish(member, "Anti-nuke triggered", guild);
    }

  } catch (err) {
    console.log("Audit error:", err.message);
  }
}

client.on('channelDelete', channel => {
  checkAudit(channel.guild, AuditLogEvent.ChannelDelete);
});

client.on('roleDelete', role => {
  checkAudit(role.guild, AuditLogEvent.RoleDelete);
});

client.on('guildBanAdd', ban => {
  checkAudit(ban.guild, AuditLogEvent.MemberBanAdd);
});

/* ================= ERROR HANDLING ================= */

process.on('unhandledRejection', err => {
  console.log("Unhandled promise rejection:", err);
});

process.on('uncaughtException', err => {
  console.log("Uncaught exception:", err);
});

/* ================= LOGIN ================= */

client.login(process.env.DISCORD_TOKEN);