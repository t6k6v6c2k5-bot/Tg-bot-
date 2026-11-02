import { config } from './config.js';
import { load, saveNow } from './store.js';
import { createBot } from './bot.js';
import { startScheduler } from './scheduler.js';

if (!config.botToken) throw new Error('Не задан BOT_TOKEN');
if (!config.geminiKey && !config.grokKey) throw new Error('Нужен хотя бы GEMINI_API_KEY или GROK_API_KEY');

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
// launch() в Telegraf 4 завершается только при остановке бота
await bot.launch({ allowedUpdates: ['message', 'chat_member'] }, () => console.log('[bot] запущен'));
