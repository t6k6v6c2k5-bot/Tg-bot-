const env = process.env;
// Ключи Gemini из разных аккаунтов: GEMINI_API_KEY (можно списком через запятую), GEMINI_API_KEYS,
// а также GEMINI_API_KEY_2 … GEMINI_API_KEY_9
const geminiKeys = [
  ...new Set(
    [env.GEMINI_API_KEY, env.GEMINI_API_KEYS, ...Array.from({ length: 8 }, (_, i) => env[`GEMINI_API_KEY_${i + 2}`])]
      .filter(Boolean)
      .flatMap((v) => v.split(/[\s,;]+/))
      .filter(Boolean),
  ),
];
const keyList = (...vals) => [...new Set(vals.filter(Boolean).flatMap((v) => v.split(/[\s,;]+/)).filter(Boolean))];
const groqKeys = keyList(env.GROQ_API_KEY, env.GROQ_API_KEYS, ...Array.from({ length: 8 }, (_, i) => env[`GROQ_API_KEY_${i + 2}`]));
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);

export const config = {
  botToken: env.BOT_TOKEN,
  geminiKeys,
  // можно списком через запятую: первая — основная, остальные — запасные
  geminiModels: (env.GEMINI_MODEL || 'gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.8-flash')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  grokKey: env.GROK_API_KEY,
  // Groq (не путать с Grok от xAI): быстрый запасной мозг и Whisper для голосовых
  groqKeys,
  groqModels: keyList(env.GROQ_MODEL || 'openai/gpt-oss-120b,openai/gpt-oss-20b'),
  groqWhisperModel: env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
  grokModel: env.GROK_MODEL || 'grok-4-fast',
  // «умный» уровень для прямых вопросов, дальше запасные из geminiModels
  geminiSmartModels: (env.GEMINI_SMART_MODEL || 'gemini-3.5-flash')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  wakeHour: num('WAKE_HOUR', 9), // когда желать доброго утра
  quietFrom: num('QUIET_FROM', 0), // ночная тишина: с … до … (по BOT_TZ)
  quietTo: num('QUIET_TO', 8),
  aliases: (env.BOT_ALIASES || 'бот')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  tz: env.BOT_TZ || 'Europe/Moscow',
  digestHour: num('DIGEST_HOUR', 22),
  digestMinMessages: num('DIGEST_MIN_MESSAGES', 20),
  dataDir: env.DATA_DIR || './data',
  aiRpm: num('AI_RPM', 12),
  // отдельный запрос-«редактор» выбирает лучшую шутку: качество выше, но запросов вдвое больше (имеет смысл на платном тарифе)
  witJudge: env.WIT_JUDGE === '1',
  mediaEnabled: env.MEDIA_ENABLED !== '0', // расшифровка голосовых и описание фото
  mediaPerHour: num('MEDIA_PER_HOUR', 15), // не больше N разборов медиа в час на чат
  roastCooldownMs: num('ROAST_COOLDOWN_HOURS', 3) * 3600_000,
  historyInPrompt: 18,
  maxReplyChars: 500,
};
