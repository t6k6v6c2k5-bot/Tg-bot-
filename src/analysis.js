import { hourOf, dayKey } from './store.js';
import { factsAbout } from './memory.js';

// Всё, что нужно Бате, чтобы «быть в теме»: состав чата, досье на людей, статистика.
// Цифры считает код, модель их только интерпретирует — так она не выдумывает.

const H = 3600_000;
const D = 24 * H;
const esc = (s) => s.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');

export const members = (st) => Object.entries(st.users).filter(([, u]) => u.name && !u.left);

const ago = (ms) => {
  if (ms < 90 * 60_000) return `${Math.max(1, Math.round(ms / 60_000))} мин назад`;
  if (ms < 36 * H) return `${Math.round(ms / H)} ч назад`;
  return `${Math.round(ms / D)} дн назад`;
};

// ---- состав чата (идёт в системный промпт) ----
export function rosterLine(st) {
  const list = members(st);
  if (!list.length) return '';
  const names = list
    .slice(0, 40)
    .map(([, u]) => (u.username ? `${u.name} (@${u.username})` : u.name))
    .join(', ');
  const extra = st.memberCount && st.memberCount - 1 > list.length ? ` Всего в чате около ${st.memberCount - 1} человек (кроме тебя): остальных ты по именам не знаешь, они ещё не писали.` : '';
  return `\nУЧАСТНИКИ ЧАТА, которых ты знаешь (${list.length}): ${names}.${extra}`;
}

// ---- поиск упомянутых людей в вопросе ----
// Падежи: «про Ваню», «Маше», «у Димы» — сравниваем по основе имени
const nameRe = (name) => {
  const n = name.trim();
  const stem = n.length >= 4 ? n.slice(0, -1) : n;
  return new RegExp(`(?<!\\p{L})${esc(stem)}${stem === n ? '' : '\\p{L}{0,3}'}(?!\\p{L})`, 'iu');
};

export function detectTargets(st, text) {
  const low = text.toLowerCase();
  return members(st)
    .filter(([, u]) => (u.username && low.includes('@' + u.username.toLowerCase())) || nameRe(u.name).test(text))
    .map(([uid]) => uid);
}

export const isAnalytic = (text) =>
  /(?<!\p{L})(кто|сколько|нас|вас|участник|состав|самый|самая|самые|топ|статист|обсуждал|о чём|о чем|что было|что за|кто такой|кто такая|вчера|за неделю|за день|сегодня|давно|активн|молчит|молчал|оцени|проанализ|анализ|разбер|характер|как думаешь|что думаешь|расскажи|чем занят|чем занимается|интересу|любит)/iu.test(text);

// ---- статистика ----
export function chatStats(st, now, windowMs) {
  const msgs = st.history.filter((m) => !m.bot && now - m.ts <= windowMs);
  const per = new Map();
  const hours = Array(24).fill(0);
  for (const m of msgs) {
    per.set(String(m.uid), (per.get(String(m.uid)) || 0) + 1);
    hours[hourOf(m.ts)]++;
  }
  const ranked = [...per.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([uid, n]) => ({ uid, n, name: st.users[uid]?.name || uid, share: msgs.length ? Math.round((n / msgs.length) * 100) : 0 }));
  const peak = hours.indexOf(Math.max(...hours));
  return { total: msgs.length, ranked, peakHour: msgs.length ? peak : null, silentMembers: silent(st, now) };
}

// Кто числится в чате, но давно не писал (или ни разу)
export function silent(st, now, days = 3) {
  return members(st)
    .filter(([, u]) => !u.lastSeen || now - u.lastSeen > days * D)
    .map(([, u]) => u.name);
}

export function statsText(st, now = Date.now()) {
  const day = chatStats(st, now, D);
  const week = chatStats(st, now, 7 * D);
  const top = (s) => (s.ranked.length ? s.ranked.slice(0, 6).map((r) => `${r.name} — ${r.n} (${r.share}%)`).join(', ') : 'никто не писал');
  const lines = [
    `За 24 часа: ${day.total} сообщений. ${top(day)}.`,
    `За неделю (в пределах моей памяти): ${week.total} сообщений. ${top(week)}.`,
  ];
  if (week.peakHour != null) lines.push(`Пик активности: около ${week.peakHour}:00.`);
  const sl = week.silentMembers;
  if (sl.length) lines.push(`Давно не писали (3+ дня) или ещё не писали: ${sl.slice(0, 12).join(', ')}.`);
  const names = members(st).map(([, u]) => `${u.name}${u.isAdmin ? ' (админ)' : ''}${u.msgs ? '' : ' — ещё ни разу не писал(а)'}`);
  if (names.length) lines.push(`Участники, которых ты знаешь по именам (${names.length}): ${names.join(', ')}.`);
  if (st.memberCount) lines.push(`Всего в чате по данным Telegram: ${st.memberCount - 1} человек (не считая тебя). Остальных по именам не знаешь.`);
  return lines.join('\n');
}

// ---- досье ----
export function dossier(st, uid, now = Date.now()) {
  const u = st.users[uid];
  if (!u) return '';
  const head = `${u.name}${u.username ? ` (@${u.username})` : ''}`;
  const seen = u.lastSeen ? `писал(а) ${ago(now - u.lastSeen)}` : 'в чате ещё ни разу не писал(а)';
  if (st.memOff?.[uid]) return `${head}: ${seen}. Просил(а) не запоминать — подробностей не веду.`;

  const mine = st.history.filter((m) => !m.bot && String(m.uid) === String(uid));
  const week = mine.filter((m) => now - m.ts <= 7 * D).length;
  const hrs = Array(24).fill(0);
  mine.forEach((m) => hrs[hourOf(m.ts)]++);
  const topHours = hrs
    .map((n, h) => [h, n])
    .filter(([, n]) => n)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => `${h}:00`);
  // с кем чаще общается (по ответам)
  const links = new Map();
  for (const m of mine) if (m.replyTo && String(m.replyTo) !== String(uid)) links.set(String(m.replyTo), (links.get(String(m.replyTo)) || 0) + 1);
  const partner = [...links.entries()].sort((a, b) => b[1] - a[1])[0];
  const facts = factsAbout(st, uid);
  const avg = mine.length ? Math.round(mine.reduce((a, m) => a + m.text.length, 0) / mine.length) : 0;

  return [
    `${head}: ${seen}${u.firstSeen ? `, в чате с ${dayKey(u.firstSeen)}` : ''}${u.isAdmin ? ', админ' : ''}.`,
    `Сообщений всего: ${u.msgs || 0}, за неделю: ${week}${avg ? `, в среднем ${avg} симв.` : ''}${topHours.length ? `; обычно пишет около ${topHours.join(', ')}` : ''}.`,
    partner && st.users[partner[0]] ? `Чаще всего отвечает: ${st.users[partner[0]].name}.` : '',
    facts.length ? `Что помнишь о нём: ${facts.join('; ')}.` : '',
    mine.length ? `Последние фразы:\n${mine.slice(-6).map((m) => `- ${m.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---- контекст для прямого вопроса ----
export function analysisContext(st, text, now = Date.now()) {
  const targets = detectTargets(st, text);
  const analytic = isAnalytic(text);
  if (!targets.length && !analytic) return '';
  const parts = [];
  for (const uid of targets.slice(0, 3)) parts.push(dossier(st, uid, now));
  if (analytic || targets.length > 1) {
    parts.push(statsText(st, now));
    const days = Object.entries(st.memory?.days || {})
      .sort()
      .slice(-5)
      .map(([d, t]) => `${d}: ${t.replace(/\s+/g, ' ').slice(0, 350)}`);
    if (days.length) parts.push(`Итоги прошлых дней:\n${days.join('\n')}`);
    if (st.memory?.memes?.length) parts.push(`Внутренние шутки: ${st.memory.memes.map((f) => f.t).join('; ')}.`);
  }
  return parts.join('\n\n').slice(0, 4500);
}
