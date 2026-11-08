import { config } from './config.js';
import { load, saveNow } from './store.js';
import { createBot } from './bot.js';
import { startScheduler } from './scheduler.js';
import { startAlerts } from './alerts.js';

if (!config.botToken) throw new Error('Не задан BOT_TOKEN');
if (!config.geminiKeys.length && !config.groqKeys.length && !config.grokKey && !config.extraProviders.length) throw new Error('Нужен хотя бы один ключ: GEMINI_API_KEY, GROQ_API_KEY, GROK_API_KEY или ключ дополнительного провайдера');
console.log(`[ai] ключей Gemini: ${config.geminiKeys.length}, Groq: ${config.groqKeys.length}, Grok: ${config.grokKey ? 'есть' : 'нет'}${config.extraProviders.length ? ', ещё: ' + config.extraProviders.map((c) => `${c.name} (${c.keys.length})`).join(', ') : ''}`);

load();
const bot = await createBot();

const stop = (sig) => {
  saveNow();
  bot.stop(sig);
  process.exit(0);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

startScheduler();
startAlerts();
// launch() в Telegraf 4 завершается только при остановке бота
await bot.launch({ allowedUpdates: ['message', 'chat_member', 'callback_query'] }, () => console.log('[bot] запущен'));
