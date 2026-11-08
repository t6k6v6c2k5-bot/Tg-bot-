import { config } from './config.js';
import { save, touchUser, hourOf } from './store.js';
import { decide, isDirect, cheapReaction, closerKind } from './filter.js';
import { app, respond, react, say } from './respond.js';
import { watchQuestion } from './scheduler.js';
import { learn, quickFacts } from './memory.js';
import { recordFeedback, isCriticism, isLeaveMeAlone } from './taste.js';
import { onHumanMessage, noteHour } from './life.js';
import { refreshRoster } from './roster.js';
import { isCatchupRequest, hoursFromText, runCatchup } from './catchup.js';
import { botOff, selfTalk } from './owner.js';
import { renameNote } from './rename.js';
import { botMode } from './botmode.js';
import { parseMyQueue, setUserGroup, loadData } from './outage.js';
import { isTimeQuestion, timeAnswer } from './clock.js';
import { isLightQuestion, isQueueFollowUp, handleLightQuestion } from './outage-ask.js';

/**
 * Общий путь для любого сообщения человека — текст, расшифрованное голосовое, описанное фото.
 * @param {object} o
 * @param {string} o.text      что видит бот (для голосового — расшифровка)
 * @param {string} [o.detect]  по какому тексту искать обращение (для фото — только подпись)
 * @param {boolean} [o.record] только учёт (статистика, «жизнь»), без ответа
 */
export async function processMessage(ctx, st, msg, { text, detect = text, record = false, nameChange = null }) {
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
  // «моя очередь 3.1»: запоминаем очередь света человека, дальше кидаем ему график
  const bm = botMode(st);
  const myQueue = bm === 'nolight' ? null : parseMyQueue(detect);
  if (myQueue) {
    const d = await loadData().catch(() => null);
    setUserGroup(st, msg.from, myQueue, d);
    save();
    console.log(`[outage] ${msg.from.first_name || msg.from.id}: очередь ${myQueue}`);
    if (await react(chatId, msg.message_id, '👌')) return;
  }
  if (record) return;

  const direct = isPrivate || isDirect({ text: detect, botUsername: app.username, aliases: config.aliases, replyToBot });

  // Обучение «блокнота» через ИИ: каждые ~12 сообщений, повтор через 5 минут, если модели были недоступны
  if (!isPrivate && bm !== 'light') {
    st.sinceLearn++;
    if (st.sinceLearn >= 12 && now - st.lastLearnAt > 5 * 60_000) {
      st.lastLearnAt = now;
      learn(chatId, st).then(save);
    }
  }

  let mode = decide({ direct, text, st, now });
  if (!selfTalk() && !direct) mode = null; // сам не пишет: только когда позвали
  // дерзость со сменой имени: отвечаем сами, даже в режиме «молчун»
  const note = bm === 'mixed' && !isPrivate && !mode && !record ? renameNote(st, msg.from.id, nameChange, now) : null;
  if (note) {
    mode = 'direct';
    console.log(`[rename] ${nameChange.from} → ${nameChange.to}: отвечаю на дерзость`);
  }
  // Человек поставил точку («понял», «ок», «збс», «спасибо», «ахах», 👍) — разговор окончен: не отвечаем,
  // модель не дёргаем; иногда ставим реакцию, чтобы не выглядело, будто бот проигнорировал
  // «да» в ответ на вопрос самого бота — не точка, а ответ: на него отвечаем
  const botAsked = (() => {
    const prev = [...st.history].slice(0, -1).reverse().find((m) => m.bot);
    return Boolean(prev && /\?\s*$/.test(prev.text) && now - prev.ts < 10 * 60_000);
  })();
  const closer = mode && (mode === 'direct' || mode === 'critic') && !botAsked && !note ? closerKind(detect) : null;
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
    // «который час»: отвечаем кодом по времени бота (Киев), а не угадываем моделью
    if (mode === 'direct' && isTimeQuestion(detect)) {
      await respondTime(chatId, st, isPrivate ? undefined : msg.message_id);
      return;
    }
    // вопросы про свет обычными словами: считаем по графику очередей, а не шутим
    // режим «только свет»: на всё, кроме графиков и времени, молчим
    if (bm === 'light' && !(mode === 'direct' && (isLightQuestion(detect) || isQueueFollowUp(st, msg.from.id, detect, now) || isTimeQuestion(detect)))) {
      console.log('[mode] только свет: не про свет, молчу');
      return;
    }
    if (bm !== 'nolight' && mode === 'direct' && (isLightQuestion(detect) || isQueueFollowUp(st, msg.from.id, detect, now))) {
      await handleLightQuestion({ chatId, st, from: msg.from, text: detect, replyTo: isPrivate ? undefined : msg.message_id });
      return;
    }
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
    await respond(chatId, st, { mode, replyTo: isPrivate ? undefined : msg.message_id, note });
    return;
  }

  // Дешёвая реакция без ИИ
  const emoji = selfTalk() && bm === 'mixed' ? cheapReaction({ text, st, now }) : null;
  if (emoji && (await react(chatId, msg.message_id, emoji))) {
    st.lastReactAt = now;
    save();
    return;
  }

  if (selfTalk() && bm === 'mixed' && !isPrivate && text.trim().endsWith('?')) watchQuestion(chatId, st, msg.message_id);
}

async function respondTime(chatId, st, replyTo) {
  await say(chatId, st, timeAnswer(), replyTo);
}
