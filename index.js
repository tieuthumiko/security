require('dotenv').config();

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.error("❌ Mongo Error:", err));

const modelsPath = path.join(__dirname, 'models');
fs.readdirSync(modelsPath).forEach(file => {
  if (file.endsWith('.js')) {
    require(`./models/${file}`);
  }
});

console.log("✅ Models Loaded");

const eventsPath = path.join(__dirname, 'events');

fs.readdirSync(eventsPath).forEach(file => {

  if (!file.endsWith('.js')) return;

  const event = require(`./events/${file}`);

  if (file === "ready.js") {
    client.once("ready", (...args) => event(client, ...args));
  } else {
    const eventName = file.replace('.js', '');
    client.on(eventName, (...args) => event(client, ...args));
  }

});

console.log("✅ Events Loaded");

require('./dashboard/server')(client);

console.log("✅ Dashboard Loaded");

client.login(process.env.TOKEN);