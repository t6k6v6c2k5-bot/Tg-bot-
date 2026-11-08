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
// Дополнительные OpenAI-совместимые провайдеры: готовые пресеты (ключ — в <NAME>_API_KEY, модели — в <NAME>_MODEL)
// и произвольные через EXTRA_LLMS="имя|https://хост/v1|ключ1,ключ2|модель1,модель2; имя2|…"
// Названия моделей в пресетах — отправная точка: они меняются, при несовпадении бот сам уходит на следующую.
const PRESETS = [
  { name: 'github', env: 'GITHUB_MODELS_TOKEN', baseUrl: 'https://models.github.ai/inference', models: 'openai/gpt-4.1-mini,openai/gpt-4o-mini' },
  { name: 'mistral', env: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', models: 'mistral-small-latest,mistral-medium-latest' },
  { name: 'openrouter', env: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', models: 'deepseek/deepseek-chat-v3.1:free,qwen/qwen3-235b-a22b:free' },
  { name: 'cerebras', env: 'CEREBRAS_API_KEY', baseUrl: 'https://api.cerebras.ai/v1', models: 'gpt-oss-120b,llama-3.3-70b' },
  { name: 'nvidia', env: 'NVIDIA_API_KEY', baseUrl: 'https://integrate.api.nvidia.com/v1', models: 'meta/llama-3.3-70b-instruct' },
  { name: 'sambanova', env: 'SAMBANOVA_API_KEY', baseUrl: 'https://api.sambanova.ai/v1', models: 'Meta-Llama-3.3-70B-Instruct' },
  { name: 'cohere', env: 'COHERE_API_KEY', baseUrl: 'https://api.cohere.ai/compatibility/v1', models: 'command-r-plus' },
];
const extraProviders = [];
for (const pr of PRESETS) {
  const keys = keyList(env[pr.env], env[`${pr.env}S`]);
  if (keys.length) extraProviders.push({ name: pr.name, baseUrl: pr.baseUrl, keys, models: keyList(env[`${pr.name.toUpperCase()}_MODEL`] || pr.models) });
}
for (const entry of (env.EXTRA_LLMS || '').split(';').map((x) => x.trim()).filter(Boolean)) {
  const [name, baseUrl, keys, models] = entry.split('|').map((x) => x?.trim());
  if (name && baseUrl && keys && models) extraProviders.push({ name: name.toLowerCase(), baseUrl: baseUrl.replace(/\/+$/, ''), keys: keyList(keys), models: keyList(models) });
}
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);

export const config = {
  botToken: env.BOT_TOKEN,
  geminiKeys,
  // можно списком через запятую: первая — основная, остальные — запасные
  geminiModels: (env.GEMINI_MODEL || 'gemini-3.5-flash-lite,gemini-flash-lite-latest,gemma-4-26b-a4b-it,gemini-3.1-flash-lite,gemini-3.8-flash')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  grokKey: env.GROK_API_KEY,
  // Groq (не путать с Grok от xAI): быстрый запасной мозг и Whisper для голосовых
  extraProviders,
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
  // Админка: числовые Telegram-ID через запятую (надёжнее всего). Если не заданы, админом становится тот,
  // кто первым напишет боту в личку /admin с ником ADMIN_USERNAME; его ID запоминается и дальше решает только он.
  adminIds: (env.ADMIN_IDS || '').split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite),
  adminUsername: (env.ADMIN_USERNAME ?? 'vladik4638').replace(/^@/, '').toLowerCase(),
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
  // Сам в чат не пишет (ни шуток, ни оживлений, ни итогов); отвечает, когда позвали, и кидает графики света
  selfTalk: env.SELF_TALK === '1',
  // Графики отключений света: https://github.com/Baskerville42/outage-data-ua
  outageRepo: env.OUTAGE_REPO || 'Baskerville42/outage-data-ua',
  outageBranch: env.OUTAGE_BRANCH || 'main',
  outageRegion: env.OUTAGE_REGION || 'dnipro', // dnipro | kyiv | kyiv-region | odesa
  outageHour: num('OUTAGE_HOUR', 7), // утренняя сводка (по BOT_TZ)
  outageEveningHour: num('OUTAGE_EVENING_HOUR', 20), // вечерняя сводка на завтра
  historyInPrompt: 18,
  maxReplyChars: 500,
};
