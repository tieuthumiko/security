const userThreatMap = new Map();

const ACTION_SCORES = {
  CHANNEL_CREATE: 2,
  CHANNEL_DELETE: 5,
  ROLE_DELETE: 6,
  ROLE_CREATE: 3,
  MEMBER_BAN: 8,
  MEMBER_KICK: 5,
  WEBHOOK_CREATE: 7,
  UNKNOWN: 3
};

const WINDOW_TIME = 15000;
const DECAY_TIME = 10000;
const DECAY_AMOUNT = 3;

function addThreat(guildId, userId, actionType) {
  const key = `${guildId}-${userId}`;
  const now = Date.now();
  const baseScore = ACTION_SCORES[actionType] || ACTION_SCORES.UNKNOWN;

  if (!userThreatMap.has(key)) {
    userThreatMap.set(key, []);
  }

  const entries = userThreatMap.get(key);
  entries.push({ score: baseScore, time: now });

  const recent = entries.filter(e => now - e.time < WINDOW_TIME);

  let multiplier = 1;
  if (recent.length >= 5) multiplier = 2;
  else if (recent.length >= 3) multiplier = 1.5;

  const totalScore =
    recent.reduce((sum, e) => sum + e.score, 0) * multiplier;

  userThreatMap.set(key, recent);

  return Math.floor(totalScore);
}

setInterval(() => {
  const now = Date.now();

  for (const [key, entries] of userThreatMap.entries()) {
    const filtered = entries
      .filter(e => now - e.time < WINDOW_TIME)
      .map(e => ({
        ...e,
        score: Math.max(0, e.score - DECAY_AMOUNT)
      }))
      .filter(e => e.score > 0);

    if (filtered.length === 0) {
      userThreatMap.delete(key);
    } else {
      userThreatMap.set(key, filtered);
    }
  }
}, DECAY_TIME);

module.exports = {
  addThreat
};