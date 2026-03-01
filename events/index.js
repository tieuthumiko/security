const fs = require("fs");
const path = require("path");

module.exports = (client) => {
  const eventsPath = path.join(__dirname);
  const eventFiles = fs
    .readdirSync(eventsPath)
    .filter(file => file !== "index.js" && file.endsWith(".js"));

  for (const file of eventFiles) {
    const event = require(path.join(eventsPath, file));

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client));
    }
  }

  console.log("Events loaded:", eventFiles.length);
};