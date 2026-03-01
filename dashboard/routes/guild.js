const router = require("express").Router();
const { ensureAuth } = require("../middleware/auth");
const GuildConfig = require("../../models/GuildConfig");
const ThreatLog = require("../../models/ThreatLog");

router.get("/", ensureAuth, async (req, res) => {
  res.render("dashboard", {
    user: req.user,
    guilds: req.user.guilds
  });
});

router.get("/:id", ensureAuth, async (req, res) => {
  const guildId = req.params.id;

  const config =
    (await GuildConfig.findOne({ guildId })) ||
    (await GuildConfig.create({ guildId }));

  const logs = await ThreatLog.find({ guildId })
    .sort({ timestamp: -1 })
    .limit(20);

  res.render("guild", {
    user: req.user,
    config,
    logs
  });
});

module.exports = router;