const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);

export const config = {
  botToken: env.BOT_TOKEN,
  geminiKey: env.GEMINI_API_KEY,
  // можно списком через запятую: первая — основная, остальные — запасные
  geminiModels: (env.GEMINI_MODEL || 'gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.8-flash')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  grokKey: env.GROK_API_KEY,
  grokModel: env.GROK_MODEL || 'grok-4-fast',
  aliases: (env.BOT_ALIASES || 'бот')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  tz: env.BOT_TZ || 'Europe/Moscow',
  digestHour: num('DIGEST_HOUR', 22),
  digestMinMessages: num('DIGEST_MIN_MESSAGES', 20),
  dataDir: env.DATA_DIR || './data',
  aiRpm: num('AI_RPM', 8),
  roastCooldownMs: num('ROAST_COOLDOWN_HOURS', 3) * 3600_000,
  historyInPrompt: 18,
  maxReplyChars: 280,
};
