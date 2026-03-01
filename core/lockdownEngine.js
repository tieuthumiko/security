const { PermissionsBitField } = require("discord.js");
const { triggerLockdown } = require("./lockdownEngine");

async function handlePunishment(member, score) {
  try {
    if (!member || !member.guild) return;

    if (score >= 30) {
      await triggerLockdown(member.guild);
      await member.ban({ reason: "Threat Level CRITICAL" });
      return "LOCKDOWN + BAN";
    }

    if (score >= 20) {
      await member.ban({ reason: "Threat Level HIGH" });
      return "BAN";
    }

    if (score >= 15) {
      await member.kick("Threat Level MEDIUM");
      return "KICK";
    }

    if (score >= 10) {
      const dangerousRoles = member.roles.cache.filter(role =>
        role.permissions.has(PermissionsBitField.Flags.Administrator)
      );

      for (const role of dangerousRoles.values()) {
        await member.roles.remove(role);
      }

      return "ROLE STRIPPED";
    }

    if (score >= 5) {
      return "WARNING";
    }

    return null;
  } catch (err) {
    console.error("Punish Error:", err);
  }
}

module.exports = {
  handlePunishment
};