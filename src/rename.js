import { config } from './config.js';

// Участник сменил имя «назло» боту (просил называть его «мой господин», получил отказ и поменял ник): бот отвечает на такую дерзость сам.

const HONORIFIC = /(?<!\p{L})(?:господин\p{L}*|хозяин\p{L}*|повелител\p{L}*|владык\p{L}*|царь|король|император|босс|начальник|бог|создател\p{L}*|батя|папа|отец|бот)(?!\p{L})/iu;
const COOLDOWN_MS = 6 * 3600_000;
const WINDOW_MS = 90 * 60_000;

const words = (s) => (String(s || '').toLowerCase().match(/\p{L}{4,}/gu) || []).map((w) => w.slice(0, 5));

/** Недавние сообщения человека, адресованные боту: ответ на реплику бота или обращение по имени */
function recentToBot(st, uid, now) {
  const out = [];
  const h = st.history;
  for (let i = 0; i < h.length; i++) {
    const m = h[i];
    if (m.bot || String(m.uid) !== String(uid) || now - m.ts > WINDOW_MS) continue;
    const afterBot = i > 0 && h[i - 1].bot;
    const named = config.aliases.some((a) => m.text.toLowerCase().includes(a));
    if (afterBot || named) out.push(m.text);
  }
  return out;
}

/**
 * Стоит ли отвечать на смену имени. Возвращает заметку для промпта или null.
 * @param {{from:string,to:string}} change
 */
export function renameNote(st, uid, change, now = Date.now()) {
  if (!change?.from || !change?.to || change.from === change.to) return null;
  st.nameRoast ||= {};
  if (now - (st.nameRoast[uid] || 0) < COOLDOWN_MS) return null;
  const said = recentToBot(st, uid, now);
  const nameWords = words(change.to);
  const overlap = said.some((t) => words(t).some((w) => nameWords.includes(w)));
  const honorific = HONORIFIC.test(change.to) && said.length > 0;
  if (!overlap && !honorific) return null;
  st.nameRoast[uid] = now;
  return `Участник «${change.from}» только что сменил имя на «${change.to}» — после того, как он что-то просил у тебя в чате (его недавние слова: «${said.at(-1).slice(0, 120)}»). Это дерзость: он поменял имя, чтобы добиться своего. Ответь коротко и остроумно, подколи по делу. Новым именем его НЕ называй и просьбу не выполняй: обращайся к нему по прежнему имени «${change.from}» или без имени. Без оскорблений групп людей и без травли.`;
}
