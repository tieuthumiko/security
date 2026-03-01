const { AuditLogEvent } = require("discord.js");
const { addThreat } = require("security/core/threatEngine");
const { handlePunishment } = require("security/core/punishEngine");

module.exports = {
  name: "channelDelete",
  async execute(channel, client) {
    try {
      const logs = await channel.guild.fetchAuditLogs({
        type: AuditLogEvent.ChannelDelete,
        limit: 1
      });

      const entry = logs.entries.first();
      if (!entry) return;

      const { executor } = entry;
      if (!executor || executor.bot) return;

      const member = await channel.guild.members.fetch(executor.id);

      const score = addThreat(
        channel.guild.id,
        executor.id,
        "CHANNEL_DELETE"
      );

      await handlePunishment(member, score);

    } catch (err) {
      console.error("channelDelete error:", err);
    }
  }
};