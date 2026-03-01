module.exports = {
  name: "ready",
  once: true,
  execute(client) {
    console.log(`🛡 ${client.user.tag} is online.`);
  }
};