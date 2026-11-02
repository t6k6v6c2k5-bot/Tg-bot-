import { generate } from './ai.js';

// «Блокнот» бати: факты о людях, внутренние мемы и стиль чата.
// Хранится в st.memory = { users: {uid: [{t, ts}]}, memes: [{t, ts}], style: '' }

const MAX_FACTS = 8;
const MAX_MEMES = 10;
const MAX_LEN = 80;
const WINDOW = 40; // сообщений в одном проходе обучения

// То, что нельзя запоминать — страховка поверх промпта
const STEMS =
  'здоров|болезн|болеет|болел|диагноз|лечит|врач|таблетк|депресс|тревожн|терапи|беремен|развод|замужем|женат|девушк|парня|бывш|свидани|' +
  'ребён|ребен|родител|сестр|зарплат|кредит|ипотек|уволил|безработ|' +
  'религ|церк|мусульм|христиан|иудей|атеист|политик|партия|президент|ориентац|лесби|' +
  'адрес|телефон|паспорт|живёт на|живет на|возраст|умер|умерл|смерт|похорон|суицид';
// короткие слова — только целиком
const WORDS =
  'муж|мужа|мужу|мужем|жена|жены|жену|женой|сын|сына|сыну|сыном|дочь|дочка|дочки|дочку|мать|мама|мамы|маму|папа|папы|папу|отец|отца|брат|брата|' +
  'дети|детей|детям|гей|лет|год|доход|долг|парень|выборы|выборов';
const SENSITIVE = new RegExp(`(?<!\\p{L})(?:(?:${STEMS})|(?:${WORDS})(?!\\p{L}))`, 'iu');

export const emptyMemory = () => ({ users: {}, memes: [], style: '', days: {} });

export function cleanFact(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim().replace(/^[-•\s]+/, '');
  if (t.length < 3 || t.length > MAX_LEN) return null;
  if (SENSITIVE.test(t)) return null;
  return t;
}

const same = (a, b) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
};

function addUnique(list, raw, max, now) {
  const t = cleanFact(raw);
  if (!t) return false;
  const dup = list.find((f) => same(f.t, t));
  if (dup) {
    dup.ts = now;
    return false;
  }
  list.push({ t, ts: now });
  if (list.length > max) {
    list.sort((a, b) => a.ts - b.ts);
    list.splice(0, list.length - max); // старейшие вытесняются
  }
  return true;
}

// parsed = { users: {Имя: [факты]}, memes: [..], style: '' }, nameToUid: Map<Имя, uid>
export function mergeMemory(st, parsed, nameToUid, now = Date.now()) {
  const m = (st.memory ||= emptyMemory());
  let added = 0;
  for (const [name, facts] of Object.entries(parsed.users || {})) {
    const uid = nameToUid.get(name);
    if (!uid || st.memOff?.[uid] || !Array.isArray(facts)) continue;
    const list = (m.users[uid] ||= []);
    for (const f of facts.slice(0, 5)) if (addUnique(list, f, MAX_FACTS, now)) added++;
  }
  if (Array.isArray(parsed.memes)) for (const f of parsed.memes.slice(0, 3)) if (addUnique((m.memes ||= []), f, MAX_MEMES, now)) added++;
  if (typeof parsed.style === 'string' && parsed.style.trim() && parsed.style.length <= 160) m.style = parsed.style.trim();
  return added;
}

export function parseJson(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

// Блок для системного промпта: что бать помнит про тех, кто сейчас в разговоре
export function memoryBlock(st, history, n = 18) {
  const m = st.memory;
  if (!m) return '';
  const uids = [...new Set(history.slice(-n).filter((x) => !x.bot).map((x) => String(x.uid)))];
  const lines = [];
  for (const uid of uids) {
    if (st.memOff?.[uid]) continue;
    const facts = m.users[uid];
    const name = st.users[uid]?.name;
    if (name && facts?.length) lines.push(`- ${name}: ${pick(facts, 3).map((f) => f.t).join('; ')}`);
  }
  const memes = m.memes?.length ? pick(m.memes, 3).map((f) => f.t) : [];
  if (!lines.length && !memes.length && !m.style) return '';
  return [
    '\nТВОЯ ПАМЯТЬ О ЧАТЕ (вспоминай изредка и к месту, как друг, который помнит; не пересказывай списком, не выдавай как досье, не используй, чтобы задеть):',
    ...lines,
    memes.length ? `Внутренние шутки чата: ${memes.join('; ')}.` : '',
    m.style ? `Как общается чат: ${m.style}. Подстраивайся под этот стиль и длину сообщений${(st.settings?.crude ?? 1) >= 2 ? ', мат допустим только в той мере, в какой он есть в чате' : ', но без мата'}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const factsAbout = (st, uid) => (st.memOff?.[uid] ? [] : (st.memory?.users[uid] || []).map((f) => f.t));

function learnPrompt(st, msgs) {
  const known = Object.entries(st.memory?.users || {})
    .map(([uid, fs]) => `${st.users[uid]?.name || uid}: ${fs.map((f) => f.t).join('; ')}`)
    .join('\n');
  const memes = (st.memory?.memes || []).map((f) => f.t).join('; ');
  const lines = msgs.map((m) => `${m.name}: ${m.text.replace(/\s+/g, ' ').slice(0, 250)}`).join('\n');
  return `Ты ведёшь «блокнот» бати чата. Ниже последние сообщения и то, что уже записано.

Верни ТОЛЬКО JSON вида {"users":{"Имя":["факт"]},"memes":["..."],"style":"..."}.
- users: короткие факты (до 70 символов) о людях: интересы и увлечения (игры, музыка, еда, спорт), привычки и повадки в чате, фирменные словечки и фразы, забавные случаи из этого чата, чем человек сам поделился по мелочи. Имя — точно как в сообщениях.
- memes: внутренние шутки и повторяющиеся приколы чата (до 70 символов).
- style: одной строкой (до 120 символов), как общается чат: длина сообщений, сленг, ирония, эмодзи, мат или без.
НЕЛЬЗЯ записывать: здоровье, семью, отношения, деньги и работу, политику, религию, национальность, ориентацию, адреса, телефоны, возраст, место жительства и всё, чем человек не хотел бы делиться вслух.
Записывай только то, что явно прозвучало. Ничего не выдумывай. Нет нового — пустые списки.

Уже записано:
${known || '(пусто)'}
Мемы: ${memes || '(нет)'}
Стиль: ${st.memory?.style || '(не определён)'}

Сообщения:
${lines}`;
}


// ---- запись БЕЗ ИИ: простые правила + повторы фраз ----
// Работают всегда, даже когда все модели недоступны.

const FACT_RULES = [
  [/(?:^|[\s,.!?])(?:я\s+)?(?:обожаю|люблю|фанатею\s+от|фанат|залип(?:ла|ал)?\s+на)\s+(.{3,45}?)(?=[.!?,;]|$)/iu, (m) => `любит ${m[1]}`],
  [/(?:^|[\s,.!?])(?:я\s+)?(?:ненавижу|терпеть\s+не\s+могу)\s+(.{3,40}?)(?=[.!?,;]|$)/iu, (m) => `не любит ${m[1]}`],
  [/(?:^|[\s,.!?])(?:я\s+)?игра(?:ю|ем)\s+в\s+(.{2,30}?)(?=[.!?,;]|$)/iu, (m) => `играет в ${m[1]}`],
  [/(?:^|[\s,.!?])(?:я\s+)?(?:увлекаюсь|занимаюсь)\s+(.{3,30}?)(?=[.!?,;]|$)/iu, (m) => `увлекается: ${m[1]}`],
  [/мо[йяёе]\s+любим\p{L}*\s+(.{3,35}?)(?=[.!?,;]|$)/iu, (m) => `любимое: ${m[1]}`],
  [/у\s+меня\s+(?:есть\s+)?(кот|кошка|кошк\p{L}*|собак\p{L}*|пёс|пес|хомяк\p{L}*|попугай\p{L}*)/iu, (m) => `есть питомец: ${m[1]}`],
];

export function addFact(st, uid, raw, now = Date.now()) {
  if (st.memOff?.[uid]) return false;
  const m = (st.memory ||= emptyMemory());
  return addUnique((m.users[uid] ||= []), raw, MAX_FACTS, now);
}

export function quickFacts(st, uid, text, now = Date.now()) {
  if (!text || st.memOff?.[uid] || text.startsWith('[')) return 0; // пометки вроде «[фото]» пропускаем
  let n = 0;
  for (const [re, fmt] of FACT_RULES) {
    const m = text.match(re);
    if (m && addFact(st, uid, fmt(m), now)) n++;
  }
  return n;
}

const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// Фраза, которую в чате повторяют ≥3 раза разные люди, — внутренний мем
export function quickMemes(st, now = Date.now()) {
  const m = (st.memory ||= emptyMemory());
  const seen = new Map();
  for (const h of st.history.slice(-300)) {
    if (h.bot || h.text.startsWith('[')) continue;
    const k = norm(h.text);
    const words = k.split(' ').length;
    if (!k || k.length > 40 || words < 2 || words > 6) continue;
    const e = seen.get(k) || { n: 0, users: new Set(), raw: h.text };
    e.n++;
    e.users.add(String(h.uid));
    seen.set(k, e);
  }
  let added = 0;
  for (const e of seen.values()) if (e.n >= 3 && e.users.size >= 2 && addUnique((m.memes ||= []), `«${e.raw.trim()}»`, MAX_MEMES, now)) added++;
  return added;
}

// Быстрая запись без ИИ раз в несколько десятков сообщений
export const ruleLearn = (st) => quickMemes(st);

const learning = new Set();

// Очередь непрочитанного: курсор st.learnedUpTo сдвигается только после УСПЕШНОГО разбора,
// поэтому если все модели недоступны, сообщения не теряются — их разберёт следующая попытка.
export async function learn(chatId, st) {
  if (learning.has(chatId)) return 0;
  learning.add(chatId);
  try {
    ruleLearn(st); // мемы фиксируем сразу, без ИИ
    const cursor = st.learnedUpTo || 0;
    const pending = st.history.filter((m) => !m.bot && !st.memOff?.[m.uid] && m.ts > cursor);
    if (pending.length < 10) return 0;
    const msgs = cursor ? pending.slice(0, WINDOW) : pending.slice(-WINDOW); // с нуля — только свежее
    // имя -> uid, неоднозначные имена пропускаем
    const byName = new Map();
    for (const m of msgs) byName.set(m.name, byName.has(m.name) && byName.get(m.name) !== String(m.uid) ? null : String(m.uid));
    const nameToUid = new Map([...byName].filter(([, v]) => v));
    const res = await generate({
      system: 'Ты аккуратный секретарь. Отвечаешь строго валидным JSON без пояснений.',
      prompt: learnPrompt(st, msgs),
      maxTokens: 700,
      temperature: 0.2,
      json: true,
    });
    if (!res) return -1; // все провайдеры недоступны: курсор не двигаем, повторим позже
    const parsed = parseJson(res.text);
    if (!parsed) {
      console.log('[memory] не удалось разобрать JSON, повторим');
      return -1;
    }
    const added = mergeMemory(st, parsed, nameToUid);
    st.learnedUpTo = msgs[msgs.length - 1].ts;
    st.sinceLearn = Math.max(0, (st.sinceLearn || 0) - msgs.length);
    console.log(`[memory] chat=${chatId} +${added} записей из ${msgs.length} сообщений (${res.provider}); в очереди ещё ${pending.length - msgs.length}`);
    return added;
  } catch (e) {
    console.error('[memory]', e.message);
    return -1;
  } finally {
    learning.delete(chatId);
  }
}

// Есть ли чему учиться прямо сейчас (для планировщика)
export const learnBacklog = (st) => st.history.filter((m) => !m.bot && !st.memOff?.[m.uid] && m.ts > (st.learnedUpTo || 0)).length;
