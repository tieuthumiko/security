const { AuditLogEvent } = require("discord.js");
const { addThreat } = require("security/core/threatEngine");
const { handlePunishment } = require("security/core/punishEngine");

module.exports = {
  name: "roleDelete",
  async execute(role) {
    try {
      const logs = await role.guild.fetchAuditLogs({
        type: AuditLogEvent.RoleDelete,
        limit: 1
      });

      const entry = logs.entries.first();
      if (!entry) return;

      const { executor } = entry;
      if (!executor || executor.bot) return;

      const member = await role.guild.members.fetch(executor.id);

      const score = addThreat(
        role.guild.id,
        executor.id,
        "ROLE_DELETE"
      );

      await handlePunishment(member, score);

    } catch (err) {
      console.error("roleDelete error:", err);
    }
  }
};