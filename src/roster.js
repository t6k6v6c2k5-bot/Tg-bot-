import { app } from './respond.js';
import { touchUser, remember, chat, save } from './store.js';
import { noteHour, onHumanMessage } from './life.js';
import { hourOf } from './store.js';

// Telegram не отдаёт ботам полный список участников группы — только админов и их общее число.
// Остальных Батя узнаёт, когда они пишут, шлют медиа, входят/выходят или их упоминают.

const ROSTER_EVERY_MS = 6 * 3600_000;

export async function refreshRoster(chatId, st) {
  st.rosterAt = Date.now();
  try {
    const admins = await app.telegram.getChatAdministrators(chatId);
    for (const a of admins) touchUser(st, a.user, { isAdmin: true, left: false });
    st.memberCount = await app.telegram.getChatMemberCount(chatId);
    save();
    console.log(`[roster] chat=${chatId} админов ${admins.length}, всего в чате ${st.memberCount}`);
  } catch (e) {
    console.warn('[roster]', e.message);
  }
}

export const rosterDue = (st, now) => now - (st.rosterAt || 0) > ROSTER_EVERY_MS;

const kind = (m) =>
  m.photo ? '[фото]'
  : m.sticker ? `[стикер ${m.sticker.emoji || ''}]`
  : m.voice ? '[голосовое]'
  : m.video_note ? '[кружок]'
  : m.video ? '[видео]'
  : m.animation ? '[гифка]'
  : m.audio ? '[музыка]'
  : m.document ? '[файл]'
  : m.poll ? `[опрос: ${m.poll.question}]`
  : m.location ? '[геопозиция]'
  : m.contact ? '[контакт]'
  : null;

// Не текстовые сообщения: записываем в историю (для статистики и контекста), но не отвечаем
export function ingestNonText(ctx) {
  const m = ctx.message;
  if (!m || m.from?.is_bot || ctx.chat.type === 'private') return;
  const st = chat(ctx.chat.id);

  // вошли / вышли
  for (const u of m.new_chat_members || []) if (!u.is_bot) touchUser(st, u, { left: false, firstSeen: Date.now() });
  if (m.left_chat_member && !m.left_chat_member.is_bot) touchUser(st, m.left_chat_member, { left: true });

  const label = kind(m);
  if (!label || !m.from) return;
  const text = m.caption ? `${label} ${m.caption}` : label;
  remember(st, {
    id: m.message_id,
    uid: m.from.id,
    username: m.from.username,
    name: m.from.first_name || m.from.username || 'аноним',
    text,
    ts: Date.now(),
    replyTo: m.reply_to_message?.from?.is_bot ? undefined : m.reply_to_message?.from?.id,
  });
  onHumanMessage(st, Date.now(), m.reply_to_message?.from?.id === app.id);
  noteHour(st, hourOf(Date.now()));
}

// Нужны права администратора у бота: тогда приходят события входа/выхода
export function onChatMember(ctx) {
  const u = ctx.chatMember;
  if (!u || u.new_chat_member.user.is_bot) return;
  const st = chat(ctx.chat.id);
  const status = u.new_chat_member.status;
  touchUser(st, u.new_chat_member.user, { left: status === 'left' || status === 'kicked', isAdmin: status === 'administrator' || status === 'creator' });
}
