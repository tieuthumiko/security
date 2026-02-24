require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ChannelType,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder
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

let trustedUsers = new Set();
let joinMap = new Map();
let messageMap = new Map();
let lockdownActive = false;

/* ==============================
   SLASH COMMANDS
============================== */

const commands = [
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show bot help menu'),

  new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Lock entire server'),

  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Unlock server'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check security status'),

  new SlashCommandBuilder()
    .setName('trust')
    .setDescription('Trust a user')
    .addUserOption(o =>
      o.setName('user')
        .setDescription('User to trust')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('untrust')
    .setDescription('Remove trusted user')
    .addUserOption(o =>
      o.setName('user')
        .setDescription('User to remove')
        .setRequired(true))
].map(c => c.toJSON());

/* ==============================
   READY
============================== */

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{
      name: '/help',
      type: ActivityType.Watching
    }],
    status: 'online'
  });

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: commands }
  );

  autoSetupLogs();
});

/* ==============================
   AUTO LOG CATEGORY
============================== */

async function autoSetupLogs() {
  client.guilds.cache.forEach(async guild => {
    try {
      let category = guild.channels.cache.find(
        c => c.name === '🛡 Security' &&
             c.type === ChannelType.GuildCategory
      );

      if (!category) {
        category = await guild.channels.create({
          name: '🛡 Security',
          type: ChannelType.GuildCategory,
          permissionOverwrites: [{
            id: guild.roles.everyone.id,
            deny: [PermissionsBitField.Flags.ViewChannel]
          }]
        });
      }

      let logChannel = guild.channels.cache.find(
        c => c.name === 'security-logs'
      );

      if (!logChannel) {
        await guild.channels.create({
          name: 'security-logs',
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: [{
            id: guild.roles.everyone.id,
            deny: [PermissionsBitField.Flags.ViewChannel]
          }]
        });
      }
    } catch {}
  });
}

function getLogChannel(guild) {
  return guild.channels.cache.find(c => c.name === 'security-logs');
}

function isTrusted(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator)
    || trustedUsers.has(member.id);
}

/* ==============================
   JOIN RAID
============================== */

client.on('guildMemberAdd', async member => {
  const guild = member.guild;
  const now = Date.now();

  if (!joinMap.has(guild.id)) joinMap.set(guild.id, []);
  joinMap.get(guild.id).push(now);

  const recent = joinMap.get(guild.id).filter(t => now - t < 10000);

  if (recent.length >= 5 && !lockdownActive) {
    lockdownActive = true;
    await lockdownServer(guild);

    const log = getLogChannel(guild);
    if (log) log.send('Raid detected (mass join). Server locked.');
  }

  joinMap.set(guild.id, recent);
});

/* ==============================
   MESSAGE PROTECTION
============================== */

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
    await message.member.timeout(10 * 60 * 1000, 'Spam').catch(() => {});
    return;
  }

  messageMap.set(message.author.id, recent);

  if (message.mentions.everyone || message.mentions.users.size >= 5) {
    await message.delete().catch(() => {});
    await message.member.timeout(10 * 60 * 1000, 'Mass mention').catch(() => {});
  }

  if (/discord\.gg|discord\.com\/invite/.test(message.content)) {
    await message.delete().catch(() => {});
  }
});

/* ==============================
   LOCKDOWN SYSTEM
============================== */

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
  lockdownActive = false;
}

/* ==============================
   SLASH HANDLER
============================== */

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;

  if (interaction.commandName === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('🛡 Security Bot Help')
      .setColor('Red')
      .setDescription('Anti-raid protection system')
      .addFields(
        { name: '/lockdown', value: 'Lock entire server' },
        { name: '/unlock', value: 'Unlock server' },
        { name: '/status', value: 'Check system status' },
        { name: '/trust', value: 'Trust a user' },
        { name: '/untrust', value: 'Remove trusted user' }
      )
      .setFooter({ text: 'by miko' });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (!interaction.member.permissions.has(
    PermissionsBitField.Flags.Administrator))
    return interaction.reply({ content: 'Admin only.', ephemeral: true });

  if (interaction.commandName === 'lockdown') {
    await lockdownServer(guild);
    lockdownActive = true;
    interaction.reply('Server locked.');
  }

  if (interaction.commandName === 'unlock') {
    await unlockServer(guild);
    interaction.reply('Server unlocked.');
  }

  if (interaction.commandName === 'status') {
    interaction.reply(
      `Lockdown: ${lockdownActive ? 'ON' : 'OFF'}`
    );
  }

  if (interaction.commandName === 'trust') {
    const user = interaction.options.getUser('user');
    trustedUsers.add(user.id);
    interaction.reply(`${user.tag} trusted.`);
  }

  if (interaction.commandName === 'untrust') {
    const user = interaction.options.getUser('user');
    trustedUsers.delete(user.id);
    interaction.reply(`${user.tag} removed.`);
  }
});

/* ==============================
   ERROR HANDLING
============================== */

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

client.login(TOKEN);