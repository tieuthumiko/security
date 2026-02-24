require('dotenv').config();
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`Web server running on ${PORT}`));

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

/* =======================
   MEMORY (PER GUILD)
======================= */

const trustedUsers = new Map(); // guildId => Set
const joinMap = new Map();
const messageMap = new Map();
const lockdownState = new Map();

/* =======================
   SLASH COMMANDS
======================= */

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

/* =======================
   READY
======================= */

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

/* =======================
   AUTO SETUP LOG
======================= */

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
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel ] }
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
  } catch (e) {}
}

function getLog(guild) {
  return guild.channels.cache.find(c => c.name === 'security-logs');
}

function isTrusted(member) {
  if (!trustedUsers.has(member.guild.id))
    trustedUsers.set(member.guild.id, new Set());

  return member.permissions.has(PermissionsBitField.Flags.Administrator)
    || trustedUsers.get(member.guild.id).has(member.id);
}

/* =======================
   JOIN RAID
======================= */

client.on('guildMemberAdd', async member => {
  const guild = member.guild;
  const now = Date.now();

  if (!joinMap.has(guild.id)) joinMap.set(guild.id, []);
  joinMap.get(guild.id).push(now);

  const recent = joinMap.get(guild.id).filter(t => now - t < 10000);

  if (recent.length >= 5 && !lockdownState.get(guild.id)) {
    lockdownState.set(guild.id, true);
    await lockdownServer(guild);

    const log = getLog(guild);
    if (log) log.send('Mass join detected. Server locked.');

    setTimeout(async () => {
      await unlockServer(guild);
      if (log) log.send('Auto unlock after 5 minutes.');
    }, 5 * 60 * 1000);
  }

  joinMap.set(guild.id, recent);
});

/* =======================
   MESSAGE PROTECTION
======================= */

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  if (isTrusted(message.member)) return;

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

/* =======================
   ANTI NUKE
======================= */

client.on('channelDelete', async channel => {
  const logs = await channel.guild.fetchAuditLogs({
    type: AuditLogEvent.ChannelDelete,
    limit: 1
  });

  const entry = logs.entries.first();
  if (!entry) return;

  const executor = entry.executor;
  const member = await channel.guild.members.fetch(executor.id).catch(() => {});
  if (!member || isTrusted(member)) return;

  await member.ban({ reason: 'Anti Nuke: Channel Delete' }).catch(() => {});
  const log = getLog(channel.guild);
  if (log) log.send(`${executor.tag} banned (channel delete).`);
});

/* =======================
   LOCKDOWN
======================= */

async function lockdownServer(guild) {
  guild.channels.cache.forEach(async channel => {
    if (channel.type === ChannelType.GuildText) {
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { SendMessages: false }
      ).catch(() => {});
    }
  });
}

async function unlockServer(guild) {
  guild.channels.cache.forEach(async channel => {
    if (channel.type === ChannelType.GuildText) {
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { SendMessages: null }
      ).catch(() => {});
    }
  });
  lockdownState.set(guild.id, false);
}

/* =======================
   SLASH HANDLER
======================= */

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const guild = interaction.guild;

  if (interaction.commandName === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('🛡 Security Bot')
      .setColor('Red')
      .setDescription('Anti Raid + Anti Nuke Protection')
      .addFields(
        { name: '/lockdown', value: 'Lock server' },
        { name: '/unlock', value: 'Unlock server' },
        { name: '/status', value: 'Check status' },
        { name: '/trust', value: 'Trust user' },
        { name: '/untrust', value: 'Remove trust' }
      );

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return interaction.reply({ content: 'Admin only.', ephemeral: true });

  if (interaction.commandName === 'lockdown') {
    await lockdownServer(guild);
    lockdownState.set(guild.id, true);
    return interaction.reply('Server locked.');
  }

  if (interaction.commandName === 'unlock') {
    await unlockServer(guild);
    return interaction.reply('Server unlocked.');
  }

  if (interaction.commandName === 'status') {
    return interaction.reply(
      `Lockdown: ${lockdownState.get(guild.id) ? 'ON' : 'OFF'}`
    );
  }

  if (interaction.commandName === 'trust') {
    const user = interaction.options.getUser('user');
    if (!trustedUsers.has(guild.id))
      trustedUsers.set(guild.id, new Set());
    trustedUsers.get(guild.id).add(user.id);
    return interaction.reply(`${user.tag} trusted.`);
  }

  if (interaction.commandName === 'untrust') {
    const user = interaction.options.getUser('user');
    trustedUsers.get(guild.id)?.delete(user.id);
    return interaction.reply(`${user.tag} removed.`);
  }
});

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

client.login(TOKEN);