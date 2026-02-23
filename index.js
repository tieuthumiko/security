require('dotenv').config();
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  ActivityType,
  PermissionsBitField
} = require('discord.js');

/* ================= CONFIG ================= */

const SPAM_LIMIT = 8;
const SPAM_INTERVAL = 5000;

const JOIN_LIMIT = 8;
const JOIN_INTERVAL = 10000;

const ACTION_LIMIT = 4;
const ACTION_INTERVAL = 5000;

const TIMEOUT_DURATION = 10 * 60 * 1000;

const WHITELIST_USERS = ["OWNER_ID"];
const WHITELIST_ROLES = ["ROLE_ID_1", "ROLE_ID_2"];

const LOG_CHANNEL_NAME = "security-logs";

/* ================= CLIENT ================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration
  ]
});

/* ================= RENDER KEEP ALIVE ================= */

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => res.send("Bot Alive"));
app.listen(PORT, () => console.log(`Web server on ${PORT}`));

/* ================= MEMORY TRACKERS ================= */

const spamTracker = new Map();
const joinTracker = new Map();
const actionTracker = new Map();

/* ================= UTIL ================= */

function log(guild, msg) {
  const ch = guild.channels.cache.find(c => c.name === LOG_CHANNEL_NAME);
  if (ch) ch.send(msg).catch(() => {});
}

function isWhitelisted(member) {
  if (!member) return true;
  if (WHITELIST_USERS.includes(member.id)) return true;
  return member.roles.cache.some(r => WHITELIST_ROLES.includes(r.id));
}

async function safeTimeout(member, reason) {
  if (!member.moderatable) return;
  try {
    await member.timeout(TIMEOUT_DURATION, reason);
  } catch {}
}

/* ================= STATUS SYSTEM ================= */

let lastServerCount = 0;

function updateStatus(force = false) {
  const count = client.guilds.cache.size;

  if (!force && count === lastServerCount) return;

  lastServerCount = count;

  client.user.setPresence({
    activities: [{
      name: `${count} servers secured`,
      type: ActivityType.Watching
    }],
    status: "online"
  }).catch(() => {});
}

/* ================= READY ================= */

client.once('ready', () => {
  console.log(`🛡 Logged in as ${client.user.tag}`);

  updateStatus(true);
  setInterval(updateStatus, 30000);
});

/* ================= ANTI SPAM ================= */

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const member = message.member;
  if (!member || isWhitelisted(member)) return;

  const now = Date.now();
  const id = member.id;

  if (!spamTracker.has(id)) spamTracker.set(id, []);
  spamTracker.get(id).push(now);

  const recent = spamTracker.get(id)
    .filter(t => now - t < SPAM_INTERVAL);

  spamTracker.set(id, recent);

  if (recent.length >= SPAM_LIMIT || message.mentions.everyone) {
    await safeTimeout(member, "Spam detected");
    log(message.guild, `Spam: <@${id}>`);
  }
});

/* ================= ANTI MASS JOIN ================= */

client.on('guildMemberAdd', member => {
  const gid = member.guild.id;
  const now = Date.now();

  if (!joinTracker.has(gid)) joinTracker.set(gid, []);
  joinTracker.get(gid).push(now);

  const recent = joinTracker.get(gid)
    .filter(t => now - t < JOIN_INTERVAL);

  joinTracker.set(gid, recent);

  if (recent.length >= JOIN_LIMIT) {
    log(member.guild, "Mass join detected");
  }
});

/* ================= ANTI NUKE ================= */

async function checkAudit(guild, type) {
  try {
    const logs = await guild.fetchAuditLogs({ limit: 1, type });
    const entry = logs.entries.first();
    if (!entry) return;

    const executor = entry.executor;
    if (!executor) return;

    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (!member || isWhitelisted(member)) return;

    const now = Date.now();

    if (!actionTracker.has(member.id))
      actionTracker.set(member.id, []);

    actionTracker.get(member.id).push(now);

    const recent = actionTracker.get(member.id)
      .filter(t => now - t < ACTION_INTERVAL);

    actionTracker.set(member.id, recent);

    if (recent.length >= ACTION_LIMIT) {
      await safeTimeout(member, "Anti-nuke triggered");
      log(guild, `Anti-Nuke: <@${member.id}>`);
    }

  } catch {}
}

client.on('channelDelete', c => checkAudit(c.guild, AuditLogEvent.ChannelDelete));
client.on('roleDelete', r => checkAudit(r.guild, AuditLogEvent.RoleDelete));
client.on('guildBanAdd', b => checkAudit(b.guild, AuditLogEvent.MemberBanAdd));

/* ================= UPDATE STATUS ON JOIN/LEAVE ================= */

client.on('guildCreate', () => updateStatus(true));
client.on('guildDelete', () => updateStatus(true));

/* ================= GLOBAL ERROR HANDLER ================= */

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

/* ================= LOGIN ================= */

client.login(process.env.DISCORD_TOKEN);