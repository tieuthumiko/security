const mongoose = require("mongoose");

const ThreatLogSchema = new mongoose.Schema({
  guildId: String,
  userId: String,
  actionType: String,
  score: Number,
  punishment: String,
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model("ThreatLog", ThreatLogSchema);