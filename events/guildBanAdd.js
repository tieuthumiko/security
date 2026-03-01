const { AuditLogEvent } = require("discord.js");
const { addThreat } = require("security/core/threatEngine");
const { handlePunishment } = require("security/core/punishEngine");

module.exports = {
  name: "guildBanAdd",
  async execute(ban) {
    try {
      const logs = await ban.guild.fetchAuditLogs({
        type: AuditLogEvent.MemberBanAdd,
        limit: 1
      });

      const entry = logs.entries.first();
      if (!entry) return;

      const { executor } = entry;
      if (!executor || executor.bot) return;

      const member = await ban.guild.members.fetch(executor.id);

      const score = addThreat(
        ban.guild.id,
        executor.id,
        "MEMBER_BAN"
      );

      await handlePunishment(member, score);

    } catch (err) {
      console.error("guildBanAdd error:", err);
    }
  }
};