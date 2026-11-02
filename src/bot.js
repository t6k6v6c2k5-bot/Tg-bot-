import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { chat, remember, save } from './store.js';
import { decide, isDirect, cheapReaction } from './filter.js';
import { app, respond, react } from './respond.js';
import { parseCommand, handleCommand, BOT_COMMANDS } from './commands.js';
import { watchQuestion } from './scheduler.js';

export async function createBot() {
  const bot = new Telegraf(config.botToken);
  const me = await bot.telegram.getMe();
  app.telegram = bot.telegram;
  app.username = me.username;
  app.id = me.id;
  app.name = config.aliases[0] ? config.aliases[0][0].toUpperCase() + config.aliases[0].slice(1) : 'Бот';
  await bot.telegram.setMyCommands(BOT_COMMANDS).catch(() => {});

  bot.on('text', async (ctx) => {
    const msg = ctx.message;
    if (msg.from.is_bot) return;
    const chatId = ctx.chat.id;
    const st = chat(chatId);
    const text = msg.text;

    // Команды (кириллические тоже: Telegram их не размечает, поэтому разбираем сами)
    const cmd = parseCommand(text);
    if (cmd && (await handleCommand(ctx, cmd, msg))) return;

    remember(st, {
      id: msg.message_id,
      uid: msg.from.id,
      username: msg.from.username,
      name: msg.from.first_name || msg.from.username || 'аноним',
      text,
      ts: Date.now(),
    });

    const now = Date.now();
    const isPrivate = ctx.chat.type === 'private';
    const direct =
      isPrivate ||
      isDirect({
        text,
        botUsername: app.username,
        aliases: config.aliases,
        replyToBot: msg.reply_to_message?.from?.id === app.id,
      });

    const mode = decide({ direct, text, st, now });
    console.log(`[msg] chat=${chatId} (${ctx.chat.type}) direct=${direct} mode=${mode} muted=${st.settings.mutedUntil > now}`);
    if (mode) {
      await respond(chatId, st, { mode, replyTo: isPrivate ? undefined : msg.message_id });
      return;
    }

    // Дешёвая реакция без ИИ
    const emoji = cheapReaction({ text, st, now });
    if (emoji && (await react(chatId, msg.message_id, emoji))) {
      st.lastReactAt = now;
      save();
      return;
    }

    if (!isPrivate && text.trim().endsWith('?')) watchQuestion(chatId, st, msg.message_id);
  });

  bot.catch((e) => console.error('[bot]', e));
  return bot;
}
