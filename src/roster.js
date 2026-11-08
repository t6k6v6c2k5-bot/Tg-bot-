import { app } from './respond.js';
import { effActivity } from './botmode.js';
import { config } from './config.js';
import { touchUser, remember, chat, save, touchChat } from './store.js';
import { isDirect, LEVELS } from './filter.js';
import { mediaKind, label, mediaBudgetOk, transcribe, describePhoto } from './media.js';
import { processMessage } from './pipeline.js';
import { logMedia } from './log.js';

// Telegram не отдаёт ботам полный список участников группы — только админов и их общее число.
// Остальных Батя узнаёт, когда они пишут, шлют медиа, входят/выходят или их упоминают.

const ROSTER_EVERY_MS = 6 * 3600_000;

export async function refreshRoster(chatId, st) {
  st.rosterAt = Date.now();
  try {
    const admins = await app.telegram.getChatAdministrators(chatId);
    for (const a of admins) touchUser(st, a.user, { isAdmin: true, left: false });
    // в Telegraf 4 метод называется getChatMembersCount; callApi работает при любом названии
    st.memberCount = await app.telegram.callApi('getChatMemberCount', { chat_id: chatId });
    save();
    console.log(`[roster] chat=${chatId} админов ${admins.length}, всего в чате ${st.memberCount}`);
  } catch (e) {
    console.warn('[roster]', e.message);
    if (/\b403\b|chat not found|bot was kicked/i.test(e.message)) {
      st.kickedAt = Date.now();
      save();
    }
  }
}

export const rosterDue = (st, now) => now - (st.rosterAt || 0) > ROSTER_EVERY_MS;

// Не текстовые сообщения: записываем в историю (для статистики и контекста).
// Голосовые и кружки расшифровываем, фото иногда описываем — и тогда обрабатываем как обычный текст.
export async function ingestNonText(ctx) {
  const m = ctx.message;
  if (!m || m.from?.is_bot || ctx.chat.type === 'private') return;
  const st = chat(ctx.chat.id);
  touchChat(st, ctx.chat);

  // вошли / вышли
  for (const u of m.new_chat_members || []) if (!u.is_bot) touchUser(st, u, { left: false, firstSeen: Date.now() });
  if (m.left_chat_member && !m.left_chat_member.is_bot) touchUser(st, m.left_chat_member, { left: true });

  const tag = label(m);
  if (!tag || !m.from) return;
  const entry = remember(st, {
    id: m.message_id,
    uid: m.from.id,
    username: m.from.username,
    name: m.from.first_name || m.from.username || 'аноним',
    text: m.caption ? `${tag} ${m.caption}` : tag,
    ts: Date.now(),
    replyTo: m.reply_to_message?.from?.is_bot ? undefined : m.reply_to_message?.from?.id,
  });

  const now = Date.now();
  const replyToBot = m.reply_to_message?.from?.id === app.id;
  const addressed = replyToBot || isDirect({ text: m.caption || '', botUsername: app.username, aliases: config.aliases, replyToBot });
  let text = null;
  try {
    const kind = mediaKind(m);
    if (kind === 'speech' && mediaBudgetOk(st, now)) {
      st.mediaLog.push(now);
      const tr = await transcribe(m);
      if (tr) {
        entry.text = `${tag} ${tr}`;
        logMedia('голосовое', tr);
        text = tr; // дальше как обычная речь: можно обратиться к Бате голосом
      }
    } else if (kind === 'photo' && mediaBudgetOk(st, now)) {
      // описываем всегда, если обратились; иначе — иногда (экономим квоту)
      if (addressed || Math.random() < Math.min(0.5, LEVELS[effActivity(st)].p * 4)) {
        st.mediaLog.push(now);
        const d = await describePhoto(m);
        if (d) {
          entry.text = `[фото: ${d}]${m.caption ? ' ' + m.caption : ''}`;
          logMedia('фото', d);
          text = entry.text;
        }
      }
    }
  } catch (e) {
    console.warn('[media]', e.message);
  }
  save();
  // без текста для разбора — только учёт (стикеры, файлы и т.п.)
  await processMessage(ctx, st, m, { text: text ?? entry.text, detect: text && kindIsSpeech(m) ? text : m.caption || '', record: text == null && !addressed });
}

const kindIsSpeech = (m) => mediaKind(m) === 'speech';

// Нужны права администратора у бота: тогда приходят события входа/выхода
export function onChatMember(ctx) {
  const u = ctx.chatMember;
  if (!u || u.new_chat_member.user.is_bot) return;
  const st = chat(ctx.chat.id);
  const status = u.new_chat_member.status;
  touchUser(st, u.new_chat_member.user, { left: status === 'left' || status === 'kicked', isAdmin: status === 'administrator' || status === 'creator' });
}
