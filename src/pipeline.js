import { config } from './config.js';
import { save, touchUser, hourOf } from './store.js';
import { decide, isDirect, cheapReaction, closerKind } from './filter.js';
import { app, respond, react } from './respond.js';
import { watchQuestion } from './scheduler.js';
import { learn, quickFacts } from './memory.js';
import { recordFeedback, isCriticism, isLeaveMeAlone } from './taste.js';
import { onHumanMessage, noteHour } from './life.js';
import { refreshRoster } from './roster.js';
import { isCatchupRequest, hoursFromText, runCatchup } from './catchup.js';
import { botOff } from './owner.js';

/**
 * Общий путь для любого сообщения человека — текст, расшифрованное голосовое, описанное фото.
 * @param {object} o
 * @param {string} o.text      что видит бот (для голосового — расшифровка)
 * @param {string} [o.detect]  по какому тексту искать обращение (для фото — только подпись)
 * @param {boolean} [o.record] только учёт (статистика, «жизнь»), без ответа
 */
export async function processMessage(ctx, st, msg, { text, detect = text, record = false }) {
  if (botOff()) return; // бот выключен админом
  const chatId = ctx.chat.id;
  const isPrivate = ctx.chat.type === 'private';
  const now = Date.now();

  // упомянутые через text_mention известны, даже если ещё не писали
  for (const e of msg.entities || []) if (e.type === 'text_mention') touchUser(st, e.user);
  if (!isPrivate && !st.rosterAt) refreshRoster(chatId, st);

  const replyToBot = msg.reply_to_message?.from?.id === app.id;
  onHumanMessage(st, now, replyToBot);
  noteHour(st, hourOf(now));
  // Учёба без ИИ: реакция чата на реплики бота и факты по простым правилам — всегда, даже если модели недоступны
  if (!isPrivate) {
    recordFeedback(st, { text, reply_to_message: msg.reply_to_message }, now);
    // просит отстать (ответом на реплику бота): неделю не докапываемся по своей инициативе
    if (replyToBot && isLeaveMeAlone(text)) {
      st.leaveAlone = { ...(st.leaveAlone || {}), [msg.from.id]: now };
      console.log(`[leave-alone] ${msg.from.first_name || msg.from.id} просит отстать — инициативные подколы к нему на неделю отключены`);
    }
    if (quickFacts(st, msg.from.id, text, now)) console.log('[memory] факт записан правилом');
  }
  if (record) return;

  const direct = isPrivate || isDirect({ text: detect, botUsername: app.username, aliases: config.aliases, replyToBot });

  // Обучение «блокнота» через ИИ: каждые ~12 сообщений, повтор через 5 минут, если модели были недоступны
  if (!isPrivate) {
    st.sinceLearn++;
    if (st.sinceLearn >= 12 && now - st.lastLearnAt > 5 * 60_000) {
      st.lastLearnAt = now;
      learn(chatId, st).then(save);
    }
  }

  let mode = decide({ direct, text, st, now });
  // Человек поставил точку («понял», «ок», «збс», «спасибо», «ахах», 👍) — разговор окончен: не отвечаем,
  // модель не дёргаем; иногда ставим реакцию, чтобы не выглядело, будто бот проигнорировал
  // «да» в ответ на вопрос самого бота — не точка, а ответ: на него отвечаем
  const botAsked = (() => {
    const prev = [...st.history].slice(0, -1).reverse().find((m) => m.bot);
    return Boolean(prev && /\?\s*$/.test(prev.text) && now - prev.ts < 10 * 60_000);
  })();
  const closer = mode && (mode === 'direct' || mode === 'critic') && !botAsked ? closerKind(detect) : null;
  if (closer) {
    console.log(`[closer] «${detect.slice(0, 30)}» (${closer}) — разговор окончен, молчу`);
    const emoji = { thanks: '🤝', laugh: '😁', emoji: '👍', ack: '👌', praise: '😎' }[closer];
    if (Math.random() < 0.35 && Date.now() - (st.lastReactAt || 0) > 60_000 && (await react(chatId, msg.message_id, emoji))) {
      st.lastReactAt = Date.now();
      save();
    }
    return;
  }
  // Покритиковали реплику бота (ответом на неё): признать и поправиться, а не нести новую чушь
  if (mode === 'direct' && replyToBot && isCriticism(detect)) mode = 'critic';
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
