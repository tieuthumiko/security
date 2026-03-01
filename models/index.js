const mongoose = require("mongoose");

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    console.log("🗄 MongoDB Connected");
  } catch (err) {
    console.error("MongoDB Error:", err);
    process.exit(1);
  }
}

module.exports = connectDB;