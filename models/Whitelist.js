const mongoose = require("mongoose");

const WhitelistSchema = new mongoose.Schema({
  guildId: String,
  userId: String,
  roleId: String
});

module.exports = mongoose.model("Whitelist", WhitelistSchema);