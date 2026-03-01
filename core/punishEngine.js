const {
  PermissionsBitField,
  EmbedBuilder
} = require("discord.js");

const GuildConfig = require("../models/GuildConfig");
const ThreatLog = require("../models/ThreatLog");
const Whitelist = require("../models/Whitelist");

/**
 * Handle punishment based on threat score
 * @param {GuildMember} member
 * @param {number} score
 */
async function handlePunishment(member, score) {
  if (!member || !member.guild) return;

  const guild = member.guild;

  try {
    const isWhitelisted = await Whitelist.findOne({
      guildId: guild.id,
      userId: member.id
    });

    if (isWhitelisted) return "WHITELISTED";

    let config = await GuildConfig.findOne({ guildId: guild.id });

    if (!config) {
      config = await GuildConfig.create({ guildId: guild.id });
    }

    let punishment = "NONE";

    if (score >= config.lockdownThreshold) {
      punishment = "LOCKDOWN";

      await triggerLockdown(guild);

      try {
        await member.ban({ reason: "Security Lockdown Triggered" });
      } catch {}

    }
    else if (score >= config.banThreshold) {
      punishment = "BAN";
      try {
        await member.ban({ reason: "Security Threat Level Critical" });
      } catch {}
    }
    else if (score >= config.kickThreshold) {
      punishment = "KICK";
      try {
        await member.kick("Security Threat Level High");
      } catch {}
    }
    else if (score >= config.roleStripThreshold) {
      punishment = "ROLE_STRIP";

      const roles = member.roles.cache.filter(
        r => r.id !== guild.id && r.editable
      );

      for (const role of roles.values()) {
        try {
          await member.roles.remove(role);
        } catch {}
      }
    }
    else if (score >= config.warnThreshold) {
      punishment = "WARN";
    }
    await ThreatLog.create({
      guildId: guild.id,
      userId: member.id,
      actionType: "THREAT_SCORE_UPDATE",
      score,
      punishment
    });
    if (config.logChannelId) {
      const logChannel = guild.channels.cache.get(config.logChannelId);

      if (logChannel) {
        const embed = new EmbedBuilder()
          .setTitle("🛡 Security Alert")
          .setColor(getColorByPunishment(punishment))
          .addFields(
            { name: "User", value: `<@${member.id}>`, inline: true },
            { name: "Score", value: `${score}`, inline: true },
            { name: "Action", value: punishment, inline: true }
          )
          .setTimestamp();

        try {
          await logChannel.send({ embeds: [embed] });
        } catch {}
      }
    }

    return punishment;

  } catch (err) {
    console.error("punishEngine error:", err);
  }
}

async function triggerLockdown(guild) {
  const everyone = guild.roles.everyone;

  for (const channel of guild.channels.cache.values()) {
    try {
      await channel.permissionOverwrites.edit(everyone, {
        SendMessages: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false
      });
    } catch {}
  }
}

function getColorByPunishment(type) {
  switch (type) {
    case "LOCKDOWN":
      return 0xff0000;
    case "BAN":
      return 0xff3300;
    case "KICK":
      return 0xff6600;
    case "ROLE_STRIP":
      return 0xff9900;
    case "WARN":
      return 0xffff00;
    default:
      return 0x2f3136;
  }
}

module.exports = {
  handlePunishment
};