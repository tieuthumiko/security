module.exports = {
  name: "guildMemberAdd",
  async execute(member) {
    const accountAge = Date.now() - member.user.createdTimestamp;

if (accountAge < 3 * 24 * 60 * 60 * 1000) {
      try {
        await member.kick("New account detected - Anti Raid");
      } catch {}
    }
  }
};