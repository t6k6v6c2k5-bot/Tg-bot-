import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { emptyMemory } from './memory.js';

const FILE = path.join(config.dataDir, 'state.json');
const MAX_HISTORY = 1500;
const chats = new Map();
let saveTimer = null;

const fresh = () => ({
  history: [], // {id, uid, name, text, ts, bot?}
  users: {}, // uid -> {name, username}
  settings: { v: 2, activity: 3, tone: 'free', mutedUntil: 0, autonomy: true, crude: 3 },
  optOut: {}, // uid -> true  (/неподкалывай)
  taboo: [],
  roastLast: {}, // uid -> ts последнего подкола/упоминания
  unsol: [], // ts самопроизвольных реплик за последний час
  lastUnsolAt: 0,
  lastReactAt: 0,
  lastReviveAt: 0,
  lastDigestDay: '',
  lastDigestCmdAt: 0,
  memory: emptyMemory(),
  memberCount: 0, // сколько всего людей в чате (по данным Telegram)
  rosterAt: 0, // когда последний раз обновляли список админов
  memOff: {}, // uid -> true (/забудь): не запоминать этого человека
  initLog: [], // ts самостоятельных инициатив за сутки
  lastInitAt: 0,
  initTryAt: 0,
  initOpen: false, // последняя инициатива ещё ждёт реакции
  ignored: 0, // сколько инициатив подряд остались без реакции
  lastGreetDay: '',
  lastTaleAt: 0,
  initKind: '',
  engage: null, // «отзывчивость» чата на инициативы, 0..1
  kindStats: {}, // вид инициативы -> {n, ema}
  hourHist: Array(24).fill(0), // сообщений по часам суток
  pokeLast: {}, // uid -> когда последний раз звали по имени
  sinceLearn: 0, // сообщений с последнего «обучения»
  learnedUpTo: 0, // курсор: до какого момента история уже разобрана в «блокнот»
  taste: { liked: [], disliked: [], angles: {} }, // чему смеются, что не зашло, какие приёмы работают
  lastAngle: '',
  lastLearnAt: 0,
});

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [id, st] of Object.entries(raw)) {
      const chat = { ...fresh(), ...st };
      // v2 (по просьбе владельца): без рамок — тон «сам решает», пошлость 3; настройки людей (/неподкалывай, /забудь) не трогаем
      if ((chat.settings.v ?? 1) < 2) Object.assign(chat.settings, { v: 2, tone: 'free', crude: 3 });
      chats.set(Number(id), chat);
    }
    console.log(`[store] загружено чатов: ${chats.size}`);
  } catch {
    /* первый запуск */
  }
}

export function chat(id) {
  let st = chats.get(id);
  if (!st) chats.set(id, (st = fresh()));
  return st;
}

export const allChats = () => [...chats.entries()];

export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 5000);
}

export function saveNow() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(chats)));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[store] не удалось сохранить:', e.message);
  }
}

// Человек известен из служебных данных (админ, вошёл, упомянут), хотя мог ещё не писать
export function touchUser(st, user, extra = {}) {
  if (!user || user.is_bot) return;
  const u = (st.users[user.id] ||= {});
  u.name = user.first_name || user.username || u.name || 'аноним';
  u.username = user.username || u.username;
  Object.assign(u, extra);
  save();
}

export function remember(st, entry) {
  st.history.push(entry);
  if (st.history.length > MAX_HISTORY) st.history.splice(0, st.history.length - MAX_HISTORY);
  if (entry.uid && !entry.bot) {
    const u = (st.users[entry.uid] ||= {});
    u.name = entry.name;
    u.username = entry.username || u.username;
    u.firstSeen ||= entry.ts;
    u.lastSeen = entry.ts;
    u.msgs = (u.msgs || 0) + 1;
    u.left = false;
  }
  save();
  return entry;
}

// ---- время в часовом поясе бота ----
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, hour: '2-digit', hour12: false });
export const dayKey = (ts) => dayFmt.format(ts);
export const hourOf = (ts) => Number(hourFmt.format(ts)) % 24;
