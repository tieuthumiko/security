const mongoose = require("mongoose");

const GuildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  antiNuke: { type: Boolean, default: true },
  antiRaid: { type: Boolean, default: true },

  warnThreshold: { type: Number, default: 5 },
  roleStripThreshold: { type: Number, default: 10 },
  kickThreshold: { type: Number, default: 15 },
  banThreshold: { type: Number, default: 20 },
  lockdownThreshold: { type: Number, default: 30 },

  logChannelId: { type: String, default: null },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("GuildConfig", GuildConfigSchema);