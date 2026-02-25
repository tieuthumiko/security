require('dotenv').config();
const express = require('express');
const mongoose = require("mongoose");

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected");
  } catch (err) {
    console.error("MongoDB Failed:", err);
    process.exit(1);
  }
}

connectDB();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`Web server running on ${PORT}`));

/* =========================
   MONGODB CONNECT
========================= */

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log(err));

const guildSchema = new mongoose.Schema({
  guildId: String,
  trustedUsers: [String],
  lockedChannels: [String],
  lockdown: Boolean
});

const GuildModel = mongoose.model('Guild', guildSchema);

/* =========================
   DISCORD SETUP
========================= */

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

/* =========================
   UTIL
========================= */

async function getGuildData(guildId) {
  let data = await GuildModel.findOne({ guildId });
  if (!data) {
    data = await GuildModel.create({
      guildId,
      trustedUsers: [],
      lockedChannels: [],
      lockdown: false
    });
  }
  return data;
}

function isAdmin(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

/* =========================
   SLASH COMMANDS
========================= */

const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show help'),
  new SlashCommandBuilder().setName('lockdown').setDescription('Lock server'),
  new SlashCommandBuilder().setName('unlock').setDescription('Unlock server'),
  new SlashCommandBuilder().setName('status').setDescription('Security status'),
  new SlashCommandBuilder()
    .setName('trust')
    .setDescription('Trust user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
  new SlashCommandBuilder()
    .setName('untrust')
    .setDescription('Remove trusted user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
].map(c => c.toJSON());

/* =========================
   READY
========================= */

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

/* =========================
   AUTO LOG SETUP
========================= */

client.on('guildCreate', async guild => {
  await setupLogs(guild);
  await getGuildData(guild.id);
});

async function setupLogs(guild) {
  try {
    let category = guild.channels.cache.find(
      c => c.name === '🛡 Security' && c.type === ChannelType.GuildCategory
    );

    if (!category) {
      category = await guild.channels.create({
        name: '🛡 Security',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }
        ]
      });
    }

    let log = guild.channels.cache.find(c => c.name === 'security-logs');

    if (!log) {
      await guild.channels.create({
        name: 'security-logs',
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }
        ]
      });
    }
  } catch {}
}

function getLog(guild) {
  return guild.channels.cache.find(c => c.name === 'security-logs');
}

/* =========================
   LOCKDOWN SYSTEM
========================= */

async function lockdownServer(guild) {
  const data = await getGuildData(guild.id);

  guild.channels.cache.forEach(async channel => {
    if (channel.type === ChannelType.GuildText) {
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { SendMessages: false }
      ).catch(() => {});

      if (!data.lockedChannels.includes(channel.id))
        data.lockedChannels.push(channel.id);
    }
  });

  data.lockdown = true;
  await data.save();
}

async function unlockServer(guild) {
  const data = await getGuildData(guild.id);

  guild.channels.cache.forEach(async channel => {
    if (channel.type === ChannelType.GuildText) {
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { SendMessages: null }
      ).catch(() => {});
    }
  });

  data.lockdown = false;
  await data.save();
}

/* =========================
   AUTO LOCK IF PREVIOUSLY LOCKED
========================= */

client.on('channelCreate', async channel => {
  if (!channel.guild) return;

  const data = await getGuildData(channel.guild.id);

  if (data.lockedChannels.includes(channel.id)) {
    await channel.permissionOverwrites.edit(
      channel.guild.roles.everyone,
      { SendMessages: false }
    ).catch(() => {});
  }
});

/* =========================
   ANTI NUKE (CHANNEL DELETE)
========================= */

client.on('channelDelete', async channel => {
  const logs = await channel.guild.fetchAuditLogs({
    type: AuditLogEvent.ChannelDelete,
    limit: 1
  });

  const entry = logs.entries.first();
  if (!entry) return;

  const executor = await channel.guild.members.fetch(entry.executor.id).catch(() => {});
  if (!executor) return;

  const data = await getGuildData(channel.guild.id);

  if (!isAdmin(executor) && !data.trustedUsers.includes(executor.id)) {
    await executor.ban({ reason: 'Anti Nuke' }).catch(() => {});
    const log = getLog(channel.guild);
    if (log) log.send(`${executor.user.tag} banned (Channel Delete).`);
  }
});

/* =========================
   SLASH HANDLER
========================= */

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;
  const data = await getGuildData(guild.id);

  if (interaction.commandName === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('🛡 Security Bot')
      .setColor('Red')
      .setDescription('w miko')
      .addFields(
        { name: '/lockdown', value: 'Lock server' },
        { name: '/unlock', value: 'Unlock server' },
        { name: '/status', value: 'Security status' },
        { name: '/trust', value: 'Trust user' },
        { name: '/untrust', value: 'Remove trusted user' }
      );

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (!isAdmin(interaction.member))
    return interaction.reply({ content: 'Admin only.', ephemeral: true });

  if (interaction.commandName === 'lockdown') {
    await lockdownServer(guild);
    return interaction.reply('Server locked.');
  }

  if (interaction.commandName === 'unlock') {
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
    if (!data.trustedUsers.includes(user.id))
      data.trustedUsers.push(user.id);
    await data.save();
    return interaction.reply(`${user.tag} trusted.`);
  }

  if (interaction.commandName === 'untrust') {
    const user = interaction.options.getUser('user');
    data.trustedUsers = data.trustedUsers.filter(id => id !== user.id);
    await data.save();
    return interaction.reply(`${user.tag} removed.`);
  }
});

/* ========================= */

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

client.login(TOKEN);