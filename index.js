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

// ================= EXPRESS FOR RENDER =================

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Security Bot Running');
});

app.listen(PORT, () => {
  console.log(`Web server running on ${PORT}`);
});

// ================= TRACKERS =================

const spamTracker = new Map();
const joinTracker = new Map();
const actionTracker = new Map();

// ================= READY =================

client.once('ready', () => {
  console.log(`🛡 Logged in as ${client.user.tag}`);
});

// ================= HELPER =================

function getLogChannel(guild) {
  return guild.channels.cache.find(
    c => c.name === config.LOG_CHANNEL_NAME
  );
}

function isWhitelisted(id) {
  return config.WHITELIST.includes(id);
}

// ================= ANTI SPAM =================

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;

  const userId = message.author.id;
  const now = Date.now();

  if (!spamTracker.has(userId)) spamTracker.set(userId, []);
  spamTracker.get(userId).push(now);

  const recent = spamTracker.get(userId)
    .filter(t => now - t < config.SPAM_INTERVAL);

  spamTracker.set(userId, recent);

  if (recent.length >= config.SPAM_LIMIT) {
    await message.member.timeout(
      config.TIMEOUT_DURATION,
      "Spam detected"
    );

    getLogChannel(message.guild)?.send(
      `⚠ Spam detected from <@${userId}>`
    );
  }

  if (message.mentions.everyone) {
    await message.member.timeout(
      config.TIMEOUT_DURATION,
      "Mass mention"
    );
  }
});

// ================= ANTI MASS JOIN =================

client.on('guildMemberAdd', member => {
  const guildId = member.guild.id;
  const now = Date.now();

  if (!joinTracker.has(guildId)) joinTracker.set(guildId, []);
  joinTracker.get(guildId).push(now);

  const recent = joinTracker.get(guildId)
    .filter(t => now - t < config.JOIN_INTERVAL);

  joinTracker.set(guildId, recent);

  if (recent.length >= config.JOIN_LIMIT) {
    getLogChannel(member.guild)?.send(
      "🚨 Mass join detected!"
    );
  }
});

// ================= ANTI NUKE =================

async function checkAudit(guild, type) {
  const logs = await guild.fetchAuditLogs({
    limit: 1,
    type
  });

  const entry = logs.entries.first();
  if (!entry) return;

  const executor = entry.executor;
  if (!executor) return;
  if (isWhitelisted(executor.id)) return;

  const now = Date.now();

  if (!actionTracker.has(executor.id))
    actionTracker.set(executor.id, []);

  actionTracker.get(executor.id).push(now);

  const recent = actionTracker.get(executor.id)
    .filter(t => now - t < config.ACTION_INTERVAL);

  actionTracker.set(executor.id, recent);

  if (recent.length >= config.ACTION_LIMIT) {
    const member = await guild.members.fetch(executor.id);

    if (!member) return;

    if (
      member.permissions.has(
        PermissionsBitField.Flags.Administrator
      )
    ) {
      await member.roles.set([]);
      await member.timeout(
        config.TIMEOUT_DURATION,
        "Anti-nuke triggered"
      );

      getLogChannel(guild)?.send(
        `🚨 Anti-nuke activated on <@${executor.id}>`
      );
    }
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

// ================= LOGIN =================

client.login(process.env.DISCORD_TOKEN);