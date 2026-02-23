require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
  ActivityType
} = require('discord.js');
const express = require('express');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ]
});

/* ================= CONFIG ================= */

const CONFIG = {
  RAID_THRESHOLD: 10,
  RAID_INTERVAL: 10000,

  NUKE_CHANNEL_DELETE: 4,
  NUKE_ROLE_CREATE: 4,
  NUKE_BAN: 6,

  AUTO_UNLOCK_TIME: 5 * 60 * 1000
};

/* ================= MEMORY ================= */

const joinMap = new Map();
const actionMap = new Map();
const lockdownMap = new Map();

/* ================= EXPRESS SERVER (Render) ================= */

const app = express();
app.get('/', (req, res) => {
  res.send('Bot is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

/* ================= TRUST SYSTEM ================= */

function isTrusted(member) {
  if (!member) return false;

  if (member.id === member.guild.ownerId) return true;
  if (member.id === process.env.OWNER_ID) return true;

  if (member.permissions.has(PermissionFlagsBits.Administrator))
    return true;

  return false;
}

/* ================= LOG CHANNEL ================= */

async function getLogChannel(guild) {
  let channel = guild.channels.cache.find(
    c => c.name === 'security-logs'
  );

  if (channel) return channel;

  channel = await guild.channels.create({
    name: 'security-logs',
    type: ChannelType.GuildText,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      }
    ]
  });

  return channel;
}

/* ================= LOCKDOWN ================= */

async function lockdown(guild, reason) {
  if (lockdownMap.has(guild.id)) return;

  lockdownMap.set(guild.id, true);

  guild.channels.cache.forEach(channel => {
    if (channel.type === ChannelType.GuildText) {
      channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { SendMessages: false }
      ).catch(() => {});
    }
  });

  const log = await getLogChannel(guild);
  log.send(`Lockdown activated: ${reason}`);

  setTimeout(() => unlock(guild), CONFIG.AUTO_UNLOCK_TIME);
}

async function unlock(guild) {
  if (!lockdownMap.has(guild.id)) return;

  guild.channels.cache.forEach(channel => {
    if (channel.type === ChannelType.GuildText) {
      channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { SendMessages: null }
      ).catch(() => {});
    }
  });

  lockdownMap.delete(guild.id);

  const log = await getLogChannel(guild);
  log.send(`Server unlocked automatically.`);
}

/* ================= STRIP ROLES ================= */

async function stripDangerousRoles(member) {
  const dangerous = member.roles.cache.filter(role =>
    role.permissions.has(PermissionFlagsBits.Administrator) ||
    role.permissions.has(PermissionFlagsBits.ManageChannels) ||
    role.permissions.has(PermissionFlagsBits.ManageRoles) ||
    role.permissions.has(PermissionFlagsBits.BanMembers)
  );

  for (const role of dangerous.values()) {
    await member.roles.remove(role).catch(() => {});
  }
}

/* ================= ANTI RAID ================= */

client.on('guildMemberAdd', async member => {
  const guild = member.guild;

  if (!joinMap.has(guild.id))
    joinMap.set(guild.id, []);

  const now = Date.now();
  const joins = joinMap.get(guild.id);

  joins.push(now);

  const filtered = joins.filter(
    time => now - time < CONFIG.RAID_INTERVAL
  );

  joinMap.set(guild.id, filtered);

  if (filtered.length >= CONFIG.RAID_THRESHOLD) {
    await lockdown(guild, 'Raid detected');
  }
});

/* ================= ANTI NUKE ================= */

async function trackAction(guild, userId, type) {
  const key = `${guild.id}_${userId}_${type}`;
  const now = Date.now();

  if (!actionMap.has(key)) actionMap.set(key, []);

  const actions = actionMap.get(key);
  actions.push(now);

  const recent = actions.filter(t => now - t < 10000);
  actionMap.set(key, recent);

  return recent.length;
}

client.on('channelDelete', async channel => {
  const audit = await channel.guild.fetchAuditLogs({ limit: 1 });
  const entry = audit.entries.first();
  if (!entry) return;

  const member = await channel.guild.members.fetch(entry.executor.id).catch(() => null);
  if (!member || isTrusted(member)) return;

  const count = await trackAction(channel.guild, member.id, 'delete');

  if (count >= CONFIG.NUKE_CHANNEL_DELETE) {
    await stripDangerousRoles(member);
    await member.timeout(60 * 60 * 1000, 'Anti-Nuke');
    await lockdown(channel.guild, 'Channel delete nuke');
  }
});

client.on('guildBanAdd', async ban => {
  const audit = await ban.guild.fetchAuditLogs({ limit: 1 });
  const entry = audit.entries.first();
  if (!entry) return;

  const member = await ban.guild.members.fetch(entry.executor.id).catch(() => null);
  if (!member || isTrusted(member)) return;

  const count = await trackAction(ban.guild, member.id, 'ban');

  if (count >= CONFIG.NUKE_BAN) {
    await stripDangerousRoles(member);
    await member.timeout(60 * 60 * 1000, 'Anti-Nuke');
    await lockdown(ban.guild, 'Mass ban detected');
  }
});

/* ================= STATUS UPDATE ================= */

setInterval(() => {
  client.user.setActivity(
    `Protecting ${client.guilds.cache.size} servers`,
    { type: ActivityType.Watching }
  );
}, 30000);

/* ================= READY ================= */

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.TOKEN);