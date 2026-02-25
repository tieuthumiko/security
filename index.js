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
  EmbedBuilder,
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

async function getGuildData(guildId) {
  const cached = guildCache.get(guildId);
  if (cached && Date.now() - cached.timestamp < 30000)
    return cached.data;

  let data = await Guild.findOne({ guildId });
  if (!data) data = await Guild.create({ guildId });

  guildCache.set(guildId, { data, timestamp: Date.now() });
  return data;
}

async function isTrusted(member) {
  if (member.permissions.has(PermissionsBitField.Flags.Administrator))
    return true;

  try {
    const data = await getGuildData(member.guild.id);
    return data.trustedUsers.includes(member.id);
  } catch {
    return false;
  }
}

const joinMap = new Map();
const messageMap = new Map();

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: '/help', type: ActivityType.Watching }],
    status: 'online'
  });

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });

  client.guilds.cache.forEach(setupLogs);
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

client.on('guildCreate', async guild => {
  await setupLogs(guild);
});

async function setupLogs(guild) {
  try {
    let category = guild.channels.cache.find(
      c => c.name === '🛡 Security' && c.type === ChannelType.GuildCategory
    );

    if (!category) {
      category = await guild.channels.create({
        name: '🛡 Security',
        type: ChannelType.GuildCategory
      });
    }

    let log = guild.channels.cache.find(c => c.name === 'security-logs');

    if (!log) {
      await guild.channels.create({
        name: 'security-logs',
        type: ChannelType.GuildText,
        parent: category.id
      });
    }
  } catch {}
}

function getLog(guild) {
  return guild.channels.cache.find(c => c.name === 'security-logs');
}

client.on('guildMemberAdd', async member => {
  const guild = member.guild;
  const now = Date.now();

  if (!joinMap.has(guild.id)) joinMap.set(guild.id, []);
  joinMap.get(guild.id).push(now);

  const recent = joinMap.get(guild.id).filter(t => now - t < 10000);

  if (recent.length >= 5) {
    const data = await getGuildData(guild.id);
    if (!data.lockdown) {
      data.lockdown = true;
      await data.save();

      await lockdownServer(guild);
      const log = getLog(guild);
      if (log) log.send('Mass join detected. Server locked.');

      setTimeout(async () => {
        data.lockdown = false;
        await data.save();
        await unlockServer(guild);
        if (log) log.send('Auto unlock.');
      }, 5 * 60 * 1000);
    }
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

client.on('channelDelete', async channel => {
  const logs = await channel.guild.fetchAuditLogs({
    type: AuditLogEvent.ChannelDelete,
    limit: 1
  });

  const entry = logs.entries.first();
  if (!entry) return;

  const executor = entry.executor;
  const member = await channel.guild.members.fetch(executor.id).catch(() => {});
  if (!member || await isTrusted(member)) return;

  await member.ban({ reason: 'Anti Nuke: Channel Delete' }).catch(() => {});
  const log = getLog(channel.guild);
  if (log) log.send(`${executor.tag} banned (channel delete).`);
});

async function lockdownServer(guild) {
  const data = await getGuildData(guild.id);
  if (data.lockdown) return;

  data.lockdownBackup.clear();

  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;

    const overwrite = channel.permissionOverwrites.cache.get(
      guild.roles.everyone.id
    );

    if (overwrite) {
      data.lockdownBackup.set(channel.id, {
        allow: overwrite.allow.toArray(),
        deny: overwrite.deny.toArray()
      });
    } else {
      data.lockdownBackup.set(channel.id, {
        allow: [],
        deny: []
      });
    }

    await channel.permissionOverwrites.edit(
      guild.roles.everyone,
      { SendMessages: false }
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

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const guild = interaction.guild;

  if (interaction.commandName === 'help') {
    return interaction.reply({
      content: 'Security bot active.',
      ephemeral: true
    });
  }

  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return interaction.reply({ content: 'Admin only.', ephemeral: true });

  const data = await getGuildData(guild.id);

  if (interaction.commandName === 'lockdown') {
    data.lockdown = true;
    await data.save();
    await lockdownServer(guild);
    return interaction.reply('Server locked.');
  }

  if (interaction.commandName === 'unlock') {
    data.lockdown = false;
    await data.save();
    await unlockServer(guild);
    return interaction.reply('Server unlocked.');
  }

  if (interaction.commandName === 'status') {
    return interaction.reply(
      `Lockdown: ${data.lockdown ? 'ON' : 'OFF'}`
    );
  }

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