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

const userThreatMap = new Map();

function addThreat(guildId, userId, score) {
  const key = `${guildId}-${userId}`;
  const now = Date.now();

  if (!userThreatMap.has(key)) {
    userThreatMap.set(key, []);
  }

  const list = userThreatMap.get(key);

  list.push({ score, time: now });

  const recent = list.filter(t => now - t.time < 30000);

  const decayScore = recent.reduce((total, item) => {
    const age = (now - item.time) / 1000;
    const decay = Math.max(0, item.score - age * 2);
    return total + decay;
  }, 0);

  userThreatMap.set(key, recent);

  return Math.round(decayScore);
}

function dynamicThreshold(guild) {
  const size = guild.memberCount;

  if (size < 100) return 80;
  if (size < 1000) return 120;
  if (size < 5000) return 160;
  return 200;
}

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

const backupSchema = new mongoose.Schema({

  guildId: { type: String, unique: true },

  name: String,
  icon: String,

  roles: [
    {
      id: String,
      name: String,
      permissions: String,
      color: Number,
      hoist: Boolean,
      position: Number
    }
  ],

  channels: [
    {
      id: String,
      name: String,
      type: Number,
      parent: String,
      position: Number,
      topic: String,
      nsfw: Boolean,
      rateLimitPerUser: Number,
      bitrate: Number,
      userLimit: Number,
      permissionOverwrites: [
        {
          id: String,
          allow: String,
          deny: String
        }
      ]
    }
  ],

  createdAt: {
    type: Date,
    default: Date.now
  }

});

const Backup = mongoose.model("Backup", backupSchema);

const globalThreatSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  score: { type: Number, default: 0 },
  lastUpdate: { type: Number, default: Date.now }
});

const GlobalThreat = mongoose.model("GlobalThreat", globalThreatSchema);

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

setInterval(async () => {

  for (const guild of client.guilds.cache.values()) {

    const joins = joinMap.get(guild.id) || [];

    const now = Date.now();

    const recent = joins.filter(t => now - t < 15000);

    if (recent.length >= 6) {

      const data = await getGuildData(guild.id);

      if (!data.lockdown) {

        await emergencyLockdown(guild, "Raid Prediction");

        await sendSecurityAlert(guild, {
          action: "Raid Prediction",
          user: "AI Detection",
          threat: 90
        });

      }

    }

  }

}, 5000);

const messageMap = new Map();
const channelCreateMap = new Map();
const channelDeleteMap = new Map();
const globalActionMap = new Map();
const serverBackup = new Map();
const actionQueue = new Map();

setInterval(() => {
  const now = Date.now();

  for (const [key, list] of actionQueue.entries()) {
    const filtered = list.filter(a => now - a.time < 15000);

    if (filtered.length === 0)
      actionQueue.delete(key);
    else
      actionQueue.set(key, filtered);
  }

}, 60000);

const permissionSnapshot = new Map();
const auditCache = new Map();

function preventDuplicateAudit(guildId, executorId, targetId) {

  const key = `${guildId}-${executorId}-${targetId}`;
  const now = Date.now();

  if (auditCache.has(key)) {

    const last = auditCache.get(key);

    if (now - last < 5000) {
      return true;
    }

  }

  auditCache.set(key, now);
  return false;

}Z

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

  if (member.id === member.guild.ownerId)
    return true;

  const data = await getGuildData(member.guild.id).catch(() => null);
  if (!data) return false;

  return data.trustedUsers.includes(member.id);
}

async function isSuperTrusted(member) {

  if (!member) return false;

  if (member.id === member.guild.ownerId)
    return true;

  if (member.permissions.has(PermissionsBitField.Flags.Administrator))
    return true;

  const data = await getGuildData(member.guild.id).catch(() => null);
  if (!data) return false;

  if (data.trustedUsers.includes(member.id))
    return true;

  return false;
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

async function getLog(guild) {

  let category = guild.channels.cache.find(
    c => c.name === '🛡 Security' && c.type === 4
  );

  if (!category) {
    category = await guild.channels.create({
      name: '🛡 Security',
      type: ChannelType.GuildCategory,
      position: 0,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: ['ViewChannel']
        }
      ]
    }).catch(() => null);
  }

  let log = guild.channels.cache.find(
    c => c.name === 'security-logs'
  );

  if (!log) {
    log = await guild.channels.create({
      name: 'security-logs',
      type: 0,
      parent: category?.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: ['ViewChannel']
        }
      ]
    }).catch(() => null);
  }

  if (log && category && log.parentId !== category.id) {
    await log.setParent(category.id).catch(() => {});
  }

  if (category) {
    await category.setPosition(0).catch(() => {});
  }

  return log;
}

async function ensureSecurityCategory(guild) {
  let category = guild.channels.cache.find(
    c => c.name === "🛡 Security" && c.type === ChannelType.GuildCategory
  );

  if (!category) {
    category = await guild.channels.create({
      name: "🛡 Security",
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: ["ViewChannel"]
        }
      ]
    }).catch(() => null);
  }

  return category;
}

async function sendSecurityAlert(guild, data) {

  const category = await ensureSecurityCategory(guild);

  let logChannel = guild.channels.cache.find(
    c => c.name === "security-logs"
  );

  if (!logChannel) {
    logChannel = await guild.channels.create({
      name: "security-logs",
      type: 0,
      parent: category?.id
    });
  }

  const embed = {
    title: "🛡 Security Alert",
    color: 0xff0000,
    fields: [
      { name: "Action", value: data.action, inline: true },
      { name: "User", value: data.user, inline: true },
      { name: "Threat Score", value: `${data.threat}%`, inline: true },
      { name: "Time", value: `<t:${Math.floor(Date.now()/1000)}:F>` }
    ],
    footer: { text: "by miko" }
  };

  await logChannel.send({ embeds: [embed] }).catch(() => {});
}

async function globalBan(userId, sourceGuildId) {

  for (const g of client.guilds.cache.values()) {

    if (g.id === sourceGuildId) continue;

    await new Promise(r => setTimeout(r, 1200));

    const member = await g.members.fetch(userId).catch(() => null);

    if (!member) continue;
    if (!member.bannable) continue;
    if (member.id === g.ownerId) continue;

    await member.ban({ reason: "Global Anti Nuke" }).catch(() => {});
  }

}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: '/help', type: ActivityType.Watching }],
    status: 'online'
  });

  client.guilds.cache.forEach(guild => {
  guild.roles.cache.forEach(role => {
    permissionSnapshot.set(role.id, role.permissions.bitfield.toString());
  });
});

  for (const guild of client.guilds.cache.values()) {
    await backupServer(guild);
  }
  client.guilds.cache.forEach(guild => {
  serverBackup.set(guild.id, {
    name: guild.name,
    icon: guild.iconURL({ extension: "png", size: 1024 })
  });
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

async function fetchRecentAudit(guild, type, targetId) {
  const logs = await guild.fetchAuditLogs({
    type,
    limit: 5
  }).catch(() => null);

  if (!logs) return null;

  const now = Date.now();

  return logs.entries.find(entry =>
    entry.target?.id === targetId &&
    now - entry.createdTimestamp < 5000
  ) || null;
}

async function lockdownServer(guild) {
  const data = await getGuildData(guild.id);
  if (data.lockdown) return;

  if (!data.lockdownBackup) {
    data.lockdownBackup = new Map();
  }

  data.lockdownBackup = new Map();

  for (const channel of guild.channels.cache.values()) {

    if (!channel.permissionOverwrites) continue;

    const snapshot = [];

    channel.permissionOverwrites.cache.forEach(overwrite => {
      snapshot.push({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.toArray(),
        deny: overwrite.deny.toArray()
      });
    });

    data.lockdownBackup.set(channel.id, snapshot);

    await channel.permissionOverwrites.edit(
      guild.roles.everyone.id,
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

async function restoreServer(guild) {

  const backup = await Backup.findOne({ guildId: guild.id });
  if (!backup) return;

  if (guild.name !== backup.name)
    await guild.setName(backup.name).catch(() => {});

  for (const roleData of backup.roles) {

    if (!guild.roles.cache.find(r => r.name === roleData.name)) {

      await guild.roles.create({
        name: roleData.name,
        color: roleData.color,
        hoist: roleData.hoist,
        permissions: BigInt(roleData.permissions)
      }).catch(() => {});
    }
  }

  for (const ch of backup.channels) {

    if (!guild.channels.cache.find(c => c.name === ch.name)) {

      await guild.channels.create({
  name: ch.name,
  type: ch.type,
  parent: guild.channels.cache.get(ch.parent) || null,
  position: ch.position,
  topic: ch.topic || null,
  nsfw: ch.nsfw || false,
  rateLimitPerUser: ch.rateLimitPerUser || 0,
  bitrate: ch.bitrate || undefined,
  userLimit: ch.userLimit || undefined,
  permissionOverwrites: ch.permissionOverwrites?.map(o => ({
    id: o.id,
    allow: BigInt(o.allow),
    deny: BigInt(o.deny)
        })) || []
      }).catch(() => {});
    }
  }

  for (const roleData of backup.roles) {
  const role = guild.roles.cache.find(r => r.name === roleData.name);
  if (!role) continue;

  if (role.position !== roleData.position) {
    await role.setPosition(roleData.position).catch(() => {});
  }
}

  console.log(`Server restored: ${guild.name}`);
}

async function backupServer(guild) {
  const roles = guild.roles.cache
    .filter(r => r.name !== '@everyone')
    .map(r => ({
      id: r.id,
      name: r.name,
      permissions: r.permissions.bitfield.toString(),
      color: r.color,
      hoist: r.hoist,
      position: r.position
    }));

  const channels = guild.channels.cache.map(c => ({
  id: c.id,
  name: c.name,
  type: c.type,
  parent: c.parentId,
  position: c.position,
  topic: c.topic,
  nsfw: c.nsfw,
  rateLimitPerUser: c.rateLimitPerUser,
  bitrate: c.bitrate,
  userLimit: c.userLimit,
  permissionOverwrites: c.permissionOverwrites.cache.map(o => ({
    id: o.id,
    allow: o.allow.bitfield.toString(),
    deny: o.deny.bitfield.toString()
  }))
}));

  await Backup.findOneAndUpdate(
    { guildId: guild.id },
    {
      guildId: guild.id,
      name: guild.name,
      icon: guild.iconURL({ extension: "png", size: 1024 }),
      roles,
      channels
    },
    { upsert: true }
  );
}

async function addGlobalThreat(userId, score) {
  let data = await GlobalThreat.findOne({ userId });
  if (!data) data = await GlobalThreat.create({ userId });

  const now = Date.now();
  const elapsed = (now - data.lastUpdate) / 1000;

  const decayAmount = elapsed * 5;
  data.score = Math.max(0, data.score - decayAmount) + score;
  data.lastUpdate = now;

  await data.save();
  return data.score;
}

async function unlockServer(guild) {
  const data = await getGuildData(guild.id);
  if (!data.lockdown) return;

  for (const [channelId, snapshot] of data.lockdownBackup.entries()) {

    const channel = guild.channels.cache.get(channelId);
    if (!channel) continue;

    await channel.permissionOverwrites.set([]).catch(() => {});

    for (const overwrite of snapshot) {

      await channel.permissionOverwrites.create(
        overwrite.id,
        {
          allow: overwrite.allow,
          deny: overwrite.deny
        }
      ).catch(() => {});
    }
  }

  data.lockdownBackup.clear();
  data.lockdown = false;
  await data.save();
}

function monitorAction(guildId, userId, type) {
  const key = `${guildId}-${userId}`;
  const now = Date.now();

  if (!actionQueue.has(key))
    actionQueue.set(key, []);

  actionQueue.get(key).push({ type, time: now });

  const recent = actionQueue.get(key)
    .filter(a => now - a.time < 15000);

  actionQueue.set(key, recent);

  const typeSet = new Set(recent.map(a => a.type));

  if (recent.length >= 4 && typeSet.size >= 2) {
    return true;
  }

  return false;

}

async function emergencyLockdown(guild, reason) {
  await lockdownServer(guild);

  const log = await getLog(guild);

  if (log) {
    await log
      .send(`Emergency Lockdown: ${reason}`)
      .catch(() => {});
  }
}

client.on("roleUpdate", async (oldRole, newRole) => {

  const guild = newRole.guild;

  const oldPerm = permissionSnapshot.get(oldRole.id);

  if (oldPerm && oldPerm !== newRole.permissions.bitfield.toString()) {

    const entry = await fetchRecentAudit(guild, AuditLogEvent.RoleUpdate, newRole.id);
if (!entry) return;

    const executor = await guild.members
      .fetch(entry.executor.id)
      .catch(() => null);

      if (!executor || await isSuperTrusted(executor)) return;

    await newRole.setPermissions(BigInt(oldPerm)).catch(() => {});
    await executor.ban({ reason: "Permission Tampering" }).catch(() => {});
    await emergencyLockdown(guild, "Permission Guardian");
  }

  if (
    !oldRole.permissions.has(PermissionsBitField.Flags.Administrator) &&
    newRole.permissions.has(PermissionsBitField.Flags.Administrator)
  ) {

    const entry = await fetchRecentAudit(guild, AuditLogEvent.RoleUpdate, newRole.id);
if (!entry) return;

    const executor = await guild.members
      .fetch(entry.executor.id)
      .catch(() => null);

    if (!executor || await isSuperTrusted(executor)) return;

    await executor.ban({ reason: "Admin Permission Inject" }).catch(() => {});
    await emergencyLockdown(guild, "Admin Permission Inject");
  }

  permissionSnapshot.set(
    newRole.id,
    newRole.permissions.bitfield.toString()
  );
});

client.on('guildMemberAdd', async member => {

  const guild = member.guild;
  const now = Date.now();

  if (!joinMap.has(guild.id)) joinMap.set(guild.id, []);
  joinMap.get(guild.id).push(now);

  const recentJoins = joinMap.get(guild.id)
    .filter(t => now - t < 10000);

    const data = await getGuildData(guild.id);

  if (!data.lockdown && recentJoins.length >= 12) {
    await emergencyLockdown(guild, 'Mass Join');
    setTimeout(() => unlockServer(guild), 5 * 60 * 1000);
  }

  joinMap.set(guild.id, recentJoins);

  if (member.user.bot) {

    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.BotAdd,
      limit: 1
    }).catch(() => null);

    if (!logs) return;

    const entry = logs.entries.first();
    if (!entry) return;

    const executor = await guild.members
      .fetch(entry.executor.id)
      .catch(() => null);

    if (!executor || await isSuperTrusted(executor)) return;

    const threat = addThreat(guild.id, executor.id, 80);

    await member.kick("Unauthorized Bot Add").catch(() => {});
    await executor.ban({ reason: "Unauthorized Bot Add" }).catch(() => {});

    await sendSecurityAlert(guild, {
      action: "Unauthorized Bot Add",
      user: executor.user.tag,
      threat
    });

    return;
  }

  if (member.user.createdTimestamp > Date.now() - 60000) {
    await member.kick("Suspicious New Account").catch(() => {});
  }

});

client.on("roleCreate", async role => {

  const guild = role.guild;

  const entry = await fetchRecentAudit(
    guild,
    AuditLogEvent.RoleCreate,
    role.id
  );

  if (!entry) return;

  const executor = await guild.members
    .fetch(entry.executor.id)
    .catch(() => null);

  if (!executor || await isSuperTrusted(executor)) return;

  const threat = addThreat(guild.id, executor.id, 70);

  if (trackAction(channelCreateMap, guild.id, executor.id, 10000, 3)) {

    await role.delete().catch(() => {});
    await executor.ban({ reason: "Mass Role Create" }).catch(() => {});

    await emergencyLockdown(guild, "Mass Role Create");

    await sendSecurityAlert(guild, {
      action: "Mass Role Create",
      user: executor.user.tag,
      threat
    });
  }
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

  const entry = await fetchRecentAudit(guild, AuditLogEvent.RoleUpdate, newRole.id);
if (!entry) return;

  const member = await guild.members.fetch(entry.executor.id).catch(() => {});
  if (!executor || await isSuperTrusted(executor)) return;

  if (
    trackAction(channelCreateMap, guild.id, member.id) ||
    trackGlobal(member.id, 'create')
  ) {
    await member.ban({ reason: 'Channel Create Spam' }).catch(() => {});
    await emergencyLockdown(guild, 'Channel Create Spam');
    await globalBan(member.id, guild.id);
  }
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;

  const entry = await fetchRecentAudit(
    channel.guild,
    AuditLogEvent.ChannelDelete,
    channel.id
  );

  if (!entry) return;

  const executor = await channel.guild.members
    .fetch(entry.executor.id)
    .catch(() => null);

  if (!executor || await isSuperTrusted(executor)) return;

  const threat = addThreat(channel.guild.id, executor.id, 70);

  const threshold = dynamicThreshold(channel.guild);
  if (threat >= threshold) {

  await executor.ban({ reason: "Channel Nuke" }).catch(() => {});

  const globalScore = await addGlobalThreat(executor.id, 80);

  if (globalScore >= 200) {
    await globalBan(executor.id, channel.guild.id);
  }

  if (monitorAction(channel.guild.id, executor.id, "channelDelete")) {
    await executor.ban({ reason: "Pattern Attack Detected" }).catch(() => {});
    await emergencyLockdown(channel.guild, "Pattern Attack");
    return;
  }

  await restoreServer(channel.guild);
  await backupServer(channel.guild);
  await emergencyLockdown(channel.guild, "Channel Nuke");

  await sendSecurityAlert(channel.guild, {
    action: "Channel Deleted",
    user: executor.user.tag,
    threat
  });

  await globalBan(executor.id, channel.guild.id);
  }

});

client.on('guildMemberUpdate', async (oldMember, newMember) => {

  const addedRoles = newMember.roles.cache.filter(r =>
    !oldMember.roles.cache.has(r.id)
  );

  for (const role of addedRoles.values()) {

    if (role.permissions.has(PermissionsBitField.Flags.Administrator)) {

      const entry = await fetchRecentAudit(guild, AuditLogEvent.RoleUpdate, newRole.id);
if (!entry) return;

      const executor = await newMember.guild.members
        .fetch(entry.executor.id)
        .catch(() => null);

      if (!executor || await isSuperTrusted(executor)) return;

      const threat = addThreat(newMember.guild.id, executor.id, 90);

      await executor.ban({
        reason: "Permission Escalation"
      }).catch(() => {});

      await emergencyLockdown(newMember.guild, "Permission Escalation");

      await sendSecurityAlert(newMember.guild, {
        action: "Admin Role Escalation",
        user: executor.user.tag,
        threat
      });
    }
  }
});

client.on('roleDelete', async role => {

  const entry = await fetchRecentAudit(guild, AuditLogEvent.RoleUpdate, newRole.id);
if (!entry) return;

  const executor = await role.guild.members
    .fetch(entry.executor.id)
    .catch(() => null);

  if (!executor || await isSuperTrusted(executor)) return;

  const threat = addThreat(role.guild.id, executor.id, 70);

  if (threat >= 100) {

    await executor.ban({ reason: "Mass Role Delete" }).catch(() => {});

    await restoreServer(role.guild);

    await emergencyLockdown(role.guild, "Role Nuke");

    await globalBan(executor.id, role.guild.id);
  }
});

client.on('webhookUpdate', async channel => {

  const guild = channel.guild;
  const now = Date.now();

  const hooks = await channel.fetchWebhooks().catch(() => null);
  if (!hooks) return;

  const logs = await guild.fetchAuditLogs({
    limit: 5
  }).catch(() => null);

  if (!logs) return;

  for (const hook of hooks.values()) {

    const entry = logs.entries.find(e =>
      (
        e.action === AuditLogEvent.WebhookCreate ||
        e.action === AuditLogEvent.WebhookDelete ||
        e.action === AuditLogEvent.WebhookUpdate
      ) &&
      e.target?.id === hook.id &&
      now - e.createdTimestamp < 8000
    );

    if (!entry) continue;

    if (!entry.executor) continue;

    if (entry.executor.id === client.user.id) continue;

    const executor = await guild.members
      .fetch(entry.executor.id)
      .catch(() => null);

    if (!executor) continue;
    if (await isTrusted(executor)) continue;

    await hook.delete().catch(() => {});

    await executor.ban({ reason: "Instant Webhook Kill" }).catch(() => {});

    const globalScore = await addGlobalThreat(executor.id, 80);

    if (globalScore >= 200) {
      await globalBan(executor.id, guild.id);
    }

    await emergencyLockdown(guild, "Webhook Attack");

  }
});

client.on('guildUpdate', async (oldGuild, newGuild) => {

  if (oldGuild.name !== newGuild.name) {

    const entry = await fetchRecentAudit(guild, AuditLogEvent.RoleUpdate, newRole.id);
if (!entry) return;

    const executor = await newGuild.members
      .fetch(entry.executor.id)
      .catch(() => null);

    if (!executor || await isSuperTrusted(executor)) return;

    const threat = addThreat(newGuild.id, executor.id, 90);

    const backup = serverBackup.get(newGuild.id);
    if (backup) {
      await newGuild.setName(backup.name).catch(() => {});
    }

    await executor.ban({ reason: "Server Rename Attack" }).catch(() => {});

    await restoreServer(newGuild);

    await emergencyLockdown(newGuild, "Server Rename Attack");
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.replied || interaction.deferred) return;

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    return; 
  }

  try {

    const guild = interaction.guild;

    const data = await getGuildData(guild.id).catch(() => null);
    if (!data)
      return interaction.editReply("Database not ready.");

    switch (interaction.commandName) {

      case 'help': {

        if (interaction.user.id !== interaction.guild.ownerId)
  return interaction.editReply("Owner only.");

        const embed = {
          color: 0x2b2d31,
          title: "🛡 Advanced Security Control Panel",
          description: "Enterprise-grade protection system.",
          fields: [
            {
              name: "Lockdown",
              value: "`/lockdown` `/unlock` `/status`"
            },
            {
              name: "Trust System",
              value: "`/trust` `/untrust`"
            },
            {
              name: "System Info",
              value:
                `Lockdown: **${data.lockdown ? "Active" : "Disabled"}**\n` +
                `Trusted Users: **${data.trustedUsers.length}**`
            }
          ],
          footer: { text: "Security Engine" },
          timestamp: new Date()
        };

        return interaction.editReply({ embeds: [embed] });
      }

      case 'lockdown':

      if (interaction.user.id !== interaction.guild.ownerId)
  return interaction.editReply("Owner only.");

        await lockdownServer(guild);
        return interaction.editReply("Server locked.");

      case 'unlock':

      if (interaction.user.id !== interaction.guild.ownerId)
  return interaction.editReply("Owner only.");

        await unlockServer(guild);
        return interaction.editReply("Server unlocked.");

      case 'status': {

        if (interaction.user.id !== interaction.guild.ownerId)
  return interaction.editReply("Owner only.");

  const apiPing = Math.round(client.ws.ping);

  const heartbeat = client.ws.ping < 0
    ? "Reconnecting..."
    : `${client.ws.ping}ms`;

  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  const memory = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);

  const embed = {
    color: 0x2b2d31,
    title: "Security System Status",
    fields: [
      {
        name: "API Ping",
        value: `\`${apiPing}ms\``,
        inline: true
      },
      {
        name: "Heartbeat",
        value: `\`${heartbeat}\``,
        inline: true
      },
      {
        name: "Uptime",
        value: `\`${hours}h ${minutes}m ${seconds}s\``,
        inline: true
      },
      {
        name: "RAM Usage",
        value: `\`${memory} MB\``,
        inline: true
      },
      {
        name: "Lockdown",
        value: data.lockdown ? "Active" : "Disabled",
        inline: true
      },
      {
        name: "Trusted Users",
        value: `\`${data.trustedUsers.length}\``,
        inline: true
      }
    ],
    footer: {
      text: `Shard: 0 • Node ${process.version}`
    },
    timestamp: new Date()
  };

  return interaction.editReply({ embeds: [embed] });
}

      case 'trust': {

        if (interaction.user.id !== interaction.guild.ownerId)
  return interaction.editReply("Owner only.");

        const user = interaction.options.getUser('user');
        if (!data.trustedUsers.includes(user.id)) {
          data.trustedUsers.push(user.id);
          await data.save();
        }
        return interaction.editReply(`${user.tag} trusted.`);
      }

      case 'untrust': {

        if (interaction.user.id !== interaction.guild.ownerId)
  return interaction.editReply("Owner only.");

        const user = interaction.options.getUser('user');
        data.trustedUsers =
          data.trustedUsers.filter(id => id !== user.id);
        await data.save();
        return interaction.editReply(`${user.tag} removed.`);
      }

    }

  } catch (err) {
    console.error(err);
    interaction.editReply("Internal error.").catch(() => {});
  }
});

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

client.login(TOKEN);