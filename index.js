require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ChannelType,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  AuditLogEvent
} = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`Web running on ${PORT}`));

mongoose.set('bufferCommands', false);

mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000
})
.then(() => console.log('MongoDB Connected'))
.catch(err => console.error('MongoDB Error:', err));

mongoose.connection.on('disconnected', () => {
  console.log('⚠ MongoDB Disconnected');
});
const guildSchema = new mongoose.Schema({
  guildId: { type: String, unique: true },
  trustedUsers: { type: [String], default: [] },
  lockdown: { type: Boolean, default: false },
  lockdownBackup: {
    type: Map,
    of: {
      allow: [String],
      deny: [String]
    },
    default: {}
  }
});

const Guild = mongoose.model('Guild', guildSchema);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const guildCache = new Map();
const joinMap = new Map();
const messageMap = new Map();
const channelCreateMap = new Map();
const channelDeleteMap = new Map();
const globalActionMap = new Map();

async function getGuildData(guildId) {
  const cached = guildCache.get(guildId);
  if (cached && Date.now() - cached.timestamp < 30000)
    return cached.data;

  let data = await Guild.findOne({ guildId }).catch(() => null);
  if (!data) data = await Guild.create({ guildId });

  guildCache.set(guildId, { data, timestamp: Date.now() });
  return data;
}

async function isTrusted(member) {
  if (member.permissions.has(PermissionsBitField.Flags.Administrator))
    return true;

  const data = await getGuildData(member.guild.id).catch(() => null);
  if (!data) return false;
  return data.trustedUsers.includes(member.id);
}

function trackAction(map, guildId, userId, time = 10000, limit = 3) {
  const key = `${guildId}-${userId}`;
  const now = Date.now();

  if (!map.has(key)) map.set(key, []);
  map.get(key).push(now);

  const recent = map.get(key).filter(t => now - t < time);
  map.set(key, recent);

  return recent.length >= limit;
}

function trackGlobal(userId, action) {
  const key = `${userId}-${action}`;
  const now = Date.now();

  if (!globalActionMap.has(key))
    globalActionMap.set(key, []);

  globalActionMap.get(key).push(now);

  const recent = globalActionMap.get(key)
    .filter(t => now - t < 60000);

  globalActionMap.set(key, recent);

  return recent.length >= 5;
}

function getLog(guild) {
  return guild.channels.cache.find(c => c.name === 'security-logs');
}

async function globalBan(userId, sourceGuildId) {
  client.guilds.cache.forEach(async g => {
    if (g.id === sourceGuildId) return;
    const m = await g.members.fetch(userId).catch(() => {});
    if (m) await m.ban({ reason: 'Global Anti Nuke' }).catch(() => {});
  });
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: '/help', type: ActivityType.Watching }],
    status: 'online'
  });

  const commands = [
    new SlashCommandBuilder().setName('help').setDescription('Show help'),
    new SlashCommandBuilder().setName('lockdown').setDescription('Lock server'),
    new SlashCommandBuilder().setName('unlock').setDescription('Unlock server'),
    new SlashCommandBuilder().setName('status').setDescription('Check status'),
    new SlashCommandBuilder()
      .setName('trust')
      .setDescription('Trust user')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder()
      .setName('untrust')
      .setDescription('Remove trusted user')
      .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });

  console.log("Slash commands registered");
});

async function lockdownServer(guild) {
  const data = await getGuildData(guild.id);
  if (data.lockdown) return;

  data.lockdownBackup.clear();

  for (const channel of guild.channels.cache.values()) {

    const overwrite = channel.permissionOverwrites.cache.get(
      guild.roles.everyone.id
    );

    if (overwrite) {
      data.lockdownBackup.set(channel.id, {
        allow: overwrite.allow.toArray(),
        deny: overwrite.deny.toArray()
      });
    } else {
      data.lockdownBackup.set(channel.id, { allow: [], deny: [] });
    }

    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      {
        SendMessages: false,
        Connect: false,
        Speak: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false
      }
    ).catch(() => {});
  }

  data.lockdown = true;
  await data.save();
}

async function unlockServer(guild) {
  const data = await getGuildData(guild.id);
  if (!data.lockdown) return;

  for (const [channelId, perms] of data.lockdownBackup.entries()) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) continue;

    await channel.permissionOverwrites.set([
      {
        id: guild.roles.everyone.id,
        allow: perms.allow,
        deny: perms.deny
      }
    ]).catch(() => {});
  }

  data.lockdownBackup.clear();
  data.lockdown = false;
  await data.save();
}

async function emergencyLockdown(guild, reason) {
  await lockdownServer(guild);
  const log = getLog(guild);
  if (log) log.send(`Emergency Lockdown: ${reason}`);
}

client.on('guildMemberAdd', async member => {
  const guild = member.guild;
  const now = Date.now();

  if (!joinMap.has(guild.id)) joinMap.set(guild.id, []);
  joinMap.get(guild.id).push(now);

  const recent = joinMap.get(guild.id)
    .filter(t => now - t < 10000);

  if (recent.length >= 5) {
    await emergencyLockdown(guild, 'Mass Join');
    setTimeout(() => unlockServer(guild), 5 * 60 * 1000);
  }

  joinMap.set(guild.id, recent);
});

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  if (await isTrusted(message.member)) return;

  const now = Date.now();
  if (!messageMap.has(message.author.id))
    messageMap.set(message.author.id, []);

  messageMap.get(message.author.id).push(now);

  const recent = messageMap.get(message.author.id)
    .filter(t => now - t < 5000);

  if (recent.length >= 6) {
    await message.delete().catch(() => {});
    await message.member.timeout(600000).catch(() => {});
  }

  messageMap.set(message.author.id, recent);

  if (message.mentions.everyone || message.mentions.users.size >= 5) {
    await message.delete().catch(() => {});
    await message.member.timeout(600000).catch(() => {});
  }

  if (/discord\.gg|discord\.com\/invite/.test(message.content)) {
    await message.delete().catch(() => {});
  }
});

client.on('channelCreate', async channel => {
  const guild = channel.guild;
  await new Promise(r => setTimeout(r, 1000));

  const logs = await guild.fetchAuditLogs({
    type: AuditLogEvent.ChannelCreate,
    limit: 1
  }).catch(() => null);

  if (!logs) return;
  const entry = logs.entries.first();
  if (!entry) return;

  const member = await guild.members.fetch(entry.executor.id).catch(() => {});
  if (!member || await isTrusted(member)) return;

  if (
    trackAction(channelCreateMap, guild.id, member.id) ||
    trackGlobal(member.id, 'create')
  ) {
    await member.ban({ reason: 'Channel Create Spam' }).catch(() => {});
    await emergencyLockdown(guild, 'Channel Create Spam');
    globalBan(member.id, guild.id);
  }
});

client.on('channelDelete', async channel => {
  const guild = channel.guild;
  await new Promise(r => setTimeout(r, 1000));

  const logs = await guild.fetchAuditLogs({
    type: AuditLogEvent.ChannelDelete,
    limit: 1
  }).catch(() => null);

  if (!logs) return;
  const entry = logs.entries.first();
  if (!entry) return;

  const member = await guild.members.fetch(entry.executor.id).catch(() => {});
  if (!member || await isTrusted(member)) return;

  if (
    trackAction(channelDeleteMap, guild.id, member.id) ||
    trackGlobal(member.id, 'delete')
  ) {
    await member.ban({ reason: 'Channel Delete Spam' }).catch(() => {});
    await emergencyLockdown(guild, 'Channel Delete Spam');
    globalBan(member.id, guild.id);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  const data = await getGuildData(guild.id);

  if (interaction.commandName === 'help')
    return interaction.reply({ content: 'Security Bot Active.', ephemeral: true });

  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return interaction.reply({ content: 'Admin only.', ephemeral: true });

  if (interaction.commandName === 'lockdown') {
    await lockdownServer(guild);
    return interaction.reply('Server locked.');
  }

  if (interaction.commandName === 'unlock') {
    await unlockServer(guild);
    return interaction.reply('Server unlocked.');
  }

  if (interaction.commandName === 'status')
    return interaction.reply(`Lockdown: ${data.lockdown ? 'ON' : 'OFF'}`);

  if (interaction.commandName === 'trust') {
    const user = interaction.options.getUser('user');
    if (!data.trustedUsers.includes(user.id)) {
      data.trustedUsers.push(user.id);
      await data.save();
    }
    return interaction.reply(`${user.tag} trusted.`);
  }

  if (interaction.commandName === 'untrust') {
    const user = interaction.options.getUser('user');
    data.trustedUsers =
      data.trustedUsers.filter(id => id !== user.id);
    await data.save();
    return interaction.reply(`${user.tag} removed.`);
  }
});

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

client.login(TOKEN);