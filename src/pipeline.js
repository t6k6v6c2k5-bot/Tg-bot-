import { config } from './config.js';
import { save, touchUser, hourOf } from './store.js';
import { decide, isDirect, cheapReaction } from './filter.js';
import { app, respond, react } from './respond.js';
import { watchQuestion } from './scheduler.js';
import { learn } from './memory.js';
import { onHumanMessage, noteHour } from './life.js';
import { refreshRoster } from './roster.js';
import { isCatchupRequest, hoursFromText, runCatchup } from './catchup.js';

/**
 * Общий путь для любого сообщения человека — текст, расшифрованное голосовое, описанное фото.
 * @param {object} o
 * @param {string} o.text      что видит бот (для голосового — расшифровка)
 * @param {string} [o.detect]  по какому тексту искать обращение (для фото — только подпись)
 * @param {boolean} [o.record] только учёт (статистика, «жизнь»), без ответа
 */
export async function processMessage(ctx, st, msg, { text, detect = text, record = false }) {
  const chatId = ctx.chat.id;
  const isPrivate = ctx.chat.type === 'private';
  const now = Date.now();

  // упомянутые через text_mention известны, даже если ещё не писали
  for (const e of msg.entities || []) if (e.type === 'text_mention') touchUser(st, e.user);
  if (!isPrivate && !st.rosterAt) refreshRoster(chatId, st);

  const replyToBot = msg.reply_to_message?.from?.id === app.id;
  onHumanMessage(st, now, replyToBot);
  noteHour(st, hourOf(now));
  if (record) return;

  const direct = isPrivate || isDirect({ text: detect, botUsername: app.username, aliases: config.aliases, replyToBot });

  // Обучение «блокнота»: раз в ~25 сообщений, не чаще раза в 10 минут
  if (!isPrivate && ++st.sinceLearn >= 25 && now - st.lastLearnAt > 10 * 60_000) {
    st.sinceLearn = 0;
    st.lastLearnAt = now;
    learn(chatId, st).then(save);
  }

  const mode = decide({ direct, text, st, now });
  console.log(`[msg] chat=${chatId} (${ctx.chat.type}) direct=${direct} mode=${mode} muted=${st.settings.mutedUntil > now}`);
  if (mode) {
    if (mode === 'direct' && isCatchupRequest(detect)) {
      await runCatchup(chatId, st, {
        uid: msg.from.id,
        name: msg.from.first_name || msg.from.username || 'друг',
        username: msg.from.username,
        replyTo: msg.message_id,
        hours: hoursFromText(detect),
      });
      return;
    }
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
}
