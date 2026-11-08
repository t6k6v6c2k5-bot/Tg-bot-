import { config } from './config.js';
import { generate } from './ai.js';
import { say } from './respond.js';
import { loadData, listGroups, parseGroup, offIntervals, daysOf, shortName, buildSummary, hhmm, minutesNow, timeline, statusNow } from './outage.js';

export { timeline, statusNow };

// Вопросы про свет обычными словами: «Батя, мне надо зарядить машину у Игоря, у него 6.2, поставлю в 10 вечера, заберу в 7 утра».
// Время и очередь вытаскивает ИИ (или запасной разбор по правилам), а считает код: на арифметике интервалов модели ошибаются.

const STRONG = /(?<!\p{L})(?:свет\p{L}*|світл\p{L}*|электр\p{L}*|електр\p{L}*|отключ\p{L}*|відключ\p{L}*|очеред\p{L}*|черг[аиуеоі]\p{L}*)/iu;
const WEAK = /(?<!\p{L})(?:график\p{L}*|графік\p{L}*|заряд\p{L}*|зарядк\p{L}*)/iu;
const QUEUE = /(?<![\d.,])\d{1,2}\s*[.,]\s*\d(?!\d)/u;

/** Это вопрос про свет/отключения (а не просто слово в болтовне)? */
export const isLightQuestion = (text) => {
  const t = text || '';
  return STRONG.test(t) || (WEAK.test(t) && QUEUE.test(t));
};

/** Человек отвечает номером очереди на наш вопрос «какая очередь?» (в течение 10 минут), хотя слов про свет в ответе нет */
export const isQueueFollowUp = (st, uid, text, now = Date.now()) => now - (st.outage?.asked?.[uid] || 0) < 10 * 60_000 && QUEUE.test(text || '');

// ---------- время ----------
const toMin = (s) => {
  const m = String(s ?? '').match(/^(\d{1,2})(?::(\d{2}))?$/);
  return m ? Math.min(24, Number(m[1])) * 60 + Number(m[2] || 0) : null;
};

/** Запасной разбор времени без ИИ: «в 10 вечера … в 7 … утра» → [22:00, 07:00] */
export function looseTimes(text) {
  const out = [];
  const re = /(?<![\d.,:])(\d{1,2})(?:[:.](\d{2}))?(?![\d.,]*\d)(?:\s*(?:час\p{L}*|год\p{L}*))?(?:\s+\p{L}+){0,2}?\s*(вечера|вечор\p{L}*|утра|ранку|ночи|ночі|дня)?/giu;
  for (const m of text.matchAll(re)) {
    let h = Number(m[1]);
    if (h > 24) continue;
    const part = (m[3] || '').toLowerCase();
    if (/веч/.test(part) && h < 12) h += 12;
    else if (/дня/.test(part) && h < 6) h += 12;
    else if (/ночи|ночі/.test(part) && h === 12) h = 0;
    out.push(h * 60 + Number(m[2] || 0));
  }
  return out;
}

// ---------- расчёты (чистые функции) ----------
const overlap = (iv, S, E) => iv.map(([a, b]) => [Math.max(a, S), Math.min(b, E)]).filter(([a, b]) => b > a);
const sum = (iv) => iv.reduce((n, [a, b]) => n + (b - a), 0);
const mergeIv = (iv) => {
  const out = [];
  for (const [a, b] of [...iv].sort((x, y) => x[0] - y[0])) {
    if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], b);
    else out.push([a, b]);
  }
  return out;
};

/** Окно [S,E] в минутах от сегодняшней полуночи: сколько света, без света, неизвестно, самый длинный кусок */
export function analyzeWindow(data, g, S, E, now = Date.now()) {
  const tl = timeline(data, g, now);
  const unknown = [];
  for (const base of [0, 1440, 2880]) if (!tl.knownDays.has(base)) unknown.push([base, base + 1440]);
  const offIn = mergeIv(overlap(tl.off, S, E));
  const maybeIn = mergeIv(overlap(tl.maybe, S, E));
  const unkIn = mergeIv(overlap(unknown, S, E));
  const blocked = mergeIv([...offIn, ...maybeIn, ...unkIn]);
  const on = [];
  let cur = S;
  for (const [a, b] of blocked) {
    if (a > cur) on.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (cur < E) on.push([cur, E]);
  const longest = on.reduce((best, iv) => (iv[1] - iv[0] > best[1] - best[0] ? iv : best), [0, 0]);
  return { total: E - S, on, off: offIn, maybe: maybeIn, unknown: unkIn, onMin: sum(on), offMin: sum(offIn), maybeMin: sum(maybeIn), unknownMin: sum(unkIn), longest };
}

// ---------- текст ----------
const hrs = (min) => {
  const h = Math.round(min / 6) / 10;
  return `${String(h).replace('.', ',')} ч`;
};
const at = (m, end = false) => (m < 1440 || (end && m === 1440) ? hhmm(m) : `${hhmm(m - 1440)} (завтра)`);
const ivText = ([a, b]) => (a >= 1440 ? `${hhmm(a - 1440)}–${hhmm(b - 1440)} (завтра)` : b > 1440 ? `${hhmm(a)}–${hhmm(b - 1440)} (завтра)` : `${hhmm(a)}–${hhmm(b)}`);
const list = (iv) => iv.map(ivText).join(', ');
const dayWord = (m) => (m >= 1440 ? 'завтра' : 'сегодня');

export function windowAnswer(g, S, E, r, { need = null, who = '' } = {}) {
  const lines = [];
  lines.push(`🔌 Черга ${shortName(g)}${who ? ` (${who})` : ''}: с ${hhmm(S % 1440)} (${dayWord(S)}) до ${hhmm(E % 1440 || (E ? 1440 : 0))} (${dayWord(E - 1)}), всего ${hrs(r.total)}`);
  const known = r.total - r.unknownMin;
  if (r.onMin === 0 && r.offMin > 0) lines.push('⛔ Света в это время не будет совсем.');
  else if (r.onMin > 0) {
    lines.push(`💡 Свет будет ${hrs(r.onMin)} из ${hrs(r.total)}${r.on.length === 1 ? ', одним куском' : ''}: ${list(r.on)}`);
  }
  if (r.offMin > 0) lines.push(`⛔ Без света: ${list(r.off)} (${hrs(r.offMin)})`);
  if (r.maybeMin > 0) lines.push(`❓ Возможно отключат: ${list(r.maybe)}`);
  if (r.unknownMin > 0) lines.push(`⚠️ Графика на ${dayWord(r.unknown[0][0])} ещё нет (${list(r.unknown)}): считал только то, что известно (${hrs(known)}).`);
  if (r.on.length > 1) lines.push(`Самый длинный непрерывный кусок света: ${hrs(r.longest[1] - r.longest[0])} (${list([r.longest])}).`);
  if (need) {
    const longest = r.longest[1] - r.longest[0];
    lines.push(longest >= need * 60 ? `✅ ${need} ч подряд зарядить влезает: ${ivText([r.longest[0], r.longest[0] + need * 60])}.` : `❌ ${need} ч подряд не набирается: максимум ${hrs(longest)} подряд, всего за окно ${hrs(r.onMin)}.`);
  }
  return lines.join('\n');
}

export function statusAnswer(g, st, now = Date.now()) {
  const n = minutesNow(now);
  if (!st) return `Черга ${shortName(g)}: данных пока нет.`;
  const head = st.on ? '🟢 Сейчас свет должен быть' : '🔴 Сейчас света нет по графику';
  if (st.on) return `${head}. ${st.until != null ? `Ближайшее отключение в ${at(st.until)} (через ${hrs(st.until - n)}).` : 'Отключений дальше в графике нет.'}`;
  return `${head}. Включат в ${at(st.until, true)} (через ${hrs(st.until - n)}).`;
}

// ---------- ИИ-разбор вопроса ----------
const SYSTEM = `Ты разбираешь вопросы про отключения света (графики по очередям вида 6.2). Верни ТОЛЬКО JSON без пояснений:
{"queue":"6.2" или null, "start":"HH:MM" или null, "end":"HH:MM" или null, "start_day":"today"|"tomorrow"|null, "need_hours":число или null, "intent":"window"|"status"|"schedule"}
- intent "window": человек называет время начала и конца (поставить на зарядку, включить прибор, ехать и т.п.): start и end обязательны; «в 10 вечера»=22:00, «в 7 утра»=07:00.
- intent "status": есть ли свет сейчас / когда включат или отключат ближайший раз.
- intent "schedule": просто показать график очереди.
- need_hours: сколько часов подряд нужно, если сказано (например «заряжается 5 часов»), иначе null.
- start_day: "tomorrow", если начало явно завтра; иначе null.
- queue: очередь, про которую спрашивают (даже если она у другого человека: «у Игоря 6.2»); null, если не названа.`;

async function llmExtract(text, now) {
  const when = new Date(now).toLocaleString('ru-RU', { timeZone: config.outageTz, weekday: 'long', hour: '2-digit', minute: '2-digit' });
  const res = await generate({ system: SYSTEM, prompt: `Сейчас: ${when}.\nСообщение: «${text}»`, maxTokens: 160, temperature: 0, json: true, high: true });
  if (!res) return null;
  try {
    return JSON.parse(res.text.replace(/^```(?:json)?|```$/gim, '').trim());
  } catch {
    return null;
  }
}

function ruleExtract(text) {
  const t = looseTimes(text.replace(QUEUE, ' '));
  const q = text.match(QUEUE);
  const base = { queue: q ? q[0] : null, need_hours: null };
  if (t.length >= 2) return { ...base, intent: 'window', start: hhmm(t[0] % 1440), end: hhmm(t[1] % 1440), start_day: null };
  if (/сейчас|зараз|есть ли|є чи|когда\s+(?:вкл|выкл|отключ|включ)|коли/iu.test(text)) return { ...base, intent: 'status' };
  return { ...base, intent: 'schedule' };
}

/**
 * Обработка вопроса про свет. Возвращает true, если ответ отправлен (иначе пусть отвечает обычный бот).
 * @param {object} o  { chatId, st, from, text, replyTo, now, extract, fetchFn }
 */
export async function handleLightQuestion({ chatId, st, from, text, replyTo, now = Date.now(), extract = llmExtract, fetchFn = fetch }) {
  const reply = (t) => say(chatId, st, t, replyTo);
  let data;
  try {
    data = await loadData(fetchFn, now);
  } catch (e) {
    console.warn('[outage-ask]', e.message);
    await reply('Не дотягуюсь до графиков света, спроси чуть позже.');
    return true;
  }
  const known = listGroups(data);
  const parsed = (await extract(text, now).catch(() => null)) || ruleExtract(text);
  const mine = st.outage?.users?.[from.id]?.group;
  const mentioned = parseGroup(text, known) || (parsed.queue ? parseGroup(String(parsed.queue), known) : null);
  const g = mentioned || mine;
  if (st.outage?.asked) delete st.outage.asked[from.id];
  const typed = text.match(QUEUE);
  if (typed && !mentioned && !parseGroup(String(parsed.queue || ''), known) && !parseGroup(text, known)) {
    await reply(`Очереди ${typed[0].replace(/\s+/g, '').replace(',', '.')} в этом регионе нет. Есть: ${known.map(shortName).join(', ')}.`);
    return true;
  }
  if (!g) {
    (st.outage ||= {}).asked = { ...(st.outage.asked || {}), [from.id]: now };
    await reply(`Не знаю, какая очередь. Назови номер (например 3.1) или запиши свою: «моя очередь 3.1». Есть: ${known.map(shortName).join(', ')}.`);
    return true;
  }
  const ownerName = !mentioned && mine ? '' : Object.values(st.outage?.users || {}).filter((u) => u.group === g).map((u) => u.name).join(', ');
  console.log(`[outage-ask] ${parsed.intent} очередь ${g}${parsed.start ? ` ${parsed.start}–${parsed.end}` : ''}`);

  if (parsed.intent === 'window' && toMin(parsed.start) != null && toMin(parsed.end) != null) {
    const n = minutesNow(now);
    let S = toMin(parsed.start) + (parsed.start_day === 'tomorrow' ? 1440 : 0);
    if (!parsed.start_day && S < n - 5) S += 1440; // «в 7 утра», когда уже день, — это завтра
    let E = toMin(parsed.end) + Math.floor(S / 1440) * 1440;
    while (E <= S) E += 1440;
    if (E - S > 36 * 60) {
      await reply('Многовато: окно длиннее 36 часов. Назови начало и конец поближе.');
      return true;
    }
    if (S >= 2880) {
      await reply('Так далеко графика нет: у меня только сегодня и завтра.');
      return true;
    }
    const need = Number(parsed.need_hours) > 0 ? Number(parsed.need_hours) : null;
    await reply(windowAnswer(g, S, E, analyzeWindow(data, g, S, E, now), { need, who: ownerName }));
    return true;
  }
  if (parsed.intent === 'status') {
    await reply(statusAnswer(g, statusNow(data, g, now), now));
    return true;
  }
  const m = buildSummary(data, {}, { title: `💡 Черга ${shortName(g)}`, only: [g], now });
  await say(chatId, st, m.text, replyTo, { entities: m.entities });
  return true;
}
