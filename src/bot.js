import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { chat, remember, touchChat } from './store.js';
import { app } from './respond.js';
import { parseCommand, handleCommand, BOT_COMMANDS } from './commands.js';
import { ingestNonText, onChatMember } from './roster.js';
import { processMessage } from './pipeline.js';
import { onAdminMessage, onAction } from './admin.js';
import { botOff } from './owner.js';

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
    if (ctx.chat.type === 'private' && (await onAdminMessage(ctx))) return; // админка (только для админа)
    const st = chat(ctx.chat.id);
    touchChat(st, ctx.chat);
    const text = msg.text;

    // Команды (кириллические тоже: Telegram их не размечает, поэтому разбираем сами)
    if (botOff()) return; // выключен: молчим, команды тоже
    // «Свет» / «Графики» словом без слэша (в любом регистре) тоже работают как команда
    const plain = text.trim().match(/^(свет|світло|графики|графіки|график|графік)[\s!.?]*$/iu);
    const cmd = parseCommand(text) || (plain ? { name: plain[1].toLowerCase(), args: '' } : null);
    if (cmd && (await handleCommand(ctx, cmd, msg))) return;

    remember(st, {
      id: msg.message_id,
      uid: msg.from.id,
      username: msg.from.username,
      name: msg.from.first_name || msg.from.username || 'аноним',
      text,
      ts: Date.now(),
      replyTo: msg.reply_to_message?.from?.is_bot ? undefined : msg.reply_to_message?.from?.id,
    });
    await processMessage(ctx, st, msg, { text });
  });

  bot.action(/^a:/, (ctx) => onAction(ctx)); // кнопки админки (проверка прав внутри)

  // всё, что не текст: стикеры, фото, голосовые, вход/выход людей (текст сюда не доходит)
  bot.on('message', (ctx) => ingestNonText(ctx));
  bot.on('chat_member', (ctx) => onChatMember(ctx));

  bot.catch((e) => console.error('[bot]', e));
  return bot;
}
