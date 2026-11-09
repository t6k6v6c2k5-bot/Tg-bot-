import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { allChats, save } from './store.js';
import { app, say } from './respond.js';
import { botOff } from './owner.js';

// Тревоги: состояние по области из открытых API (без ключа) и «где летит» из публичных каналов (по умолчанию официальный канал Повітряних Сил).
// Только цитаты из источников, ничего не додумываем. Тревога не знает тихих часов.

const FILE = () => path.join(config.dataDir, 'alerts.json');
const STATE_URLS = {
  ubilling: 'https://ubilling.net.ua/aerialalerts/',
  alertscom: 'https://alerts.com.ua/api/states',
};
const FRESH_MS = 20 * 60_000; // старые посты после простоя не пересылаем
const CHANNEL_EVERY_MS = 30_000;
const HOURLY_CAP = 10; // не больше N сообщений «где летит» в час на чат
const H = 3600_000;

let S = null; // { active: bool|null, since: ts, posts: {канал: последний id}, lastChannelAt }

const load = () => {
  if (S) return S;
  try {
    S = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    S = { active: null, since: 0, posts: {} };
  }
  S.posts ||= {};
  return S;
};
const persist = () => {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify({ active: S.active, since: S.since, posts: S.posts }));
  } catch (e) {
    console.error('[alerts] не удалось сохранить:', e.message);
  }
};
export const _resetAlerts = () => {
  S = null;
  lastChannelAt = 0;
};
let lastChannelAt = 0;

async function getText(url, fetchFn) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; batya-bot)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/** Идёт ли тревога в области: true/false, null если источники недоступны */
export async function fetchAlertState(fetchFn = fetch) {
  const region = config.alertRegion;
  try {
    const j = JSON.parse(await getText(STATE_URLS.ubilling, fetchFn));
    const v = j?.states?.[region]?.alertnow;
    if (typeof v === 'boolean') return v;
  } catch (e) {
    console.warn('[alerts] ubilling:', e.message);
  }
  try {
    const j = JSON.parse(await getText(STATE_URLS.alertscom, fetchFn));
    const v = j?.states?.find((s) => s.name === region)?.alert;
    if (typeof v === 'boolean') return v;
  } catch (e) {
    console.warn('[alerts] alerts.com.ua:', e.message);
  }
  return null;
}

// ---------- публичные каналы ----------
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => entities[n]);

/** Посты из страницы t.me/s/<канал>: [{ id, text, ts, link }] */
export function parseChannel(html, channel) {
  const out = [];
  for (const block of html.split('tgme_widget_message_wrap').slice(1)) {
    const post = block.match(/data-post="([^"/]+)\/(\d+)"/);
    const body = block.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    const time = block.match(/<time[^>]*datetime="([^"]+)"/);
    if (!post || !body) continue;
    const text = decode(body[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').trim();
    if (!text) continue;
    out.push({ id: Number(post[2]), text, ts: time ? Date.parse(time[1]) : 0, link: `https://t.me/${post[1]}/${post[2]}` });
  }
  return out.sort((a, b) => a.id - b.id);
}

const escRe = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const priorityRe = () => new RegExp(config.alertPriority.map(escRe).join('|'), 'i');
// Подходит ли пост: про нашу область, про угрозу и это не «чисто / відбій / вийшов за межі»
const THREAT = /бпла|безпілот|дрон|шахед|геран|мопед|ракет|реактив|балістик|крилат|кинджал|калібр|іскандер|(?<![а-яa-z])х-\d|вибух|приліт|обстріл|ппо|літак|курс|напрям|транзит|вектор|груп[аиу]|ціль|цілі|летить|летять|рух/i;
const CLEAR = /чисто|без\s+загроз|відбій|відбо[юя]|вийшов\s+за\s+меж|вийшли\s+за\s+меж|залишив\s+(?:меж|област)|загроза\s+минула|не\s+загрожу|не\s+зафіксован/i;
// Призывы укрыться: в местном канале это значит, что что-то летит на город
const URGENT = /(?<![а-яіїєґa-z])(?:терміново|негайно|срочно|швидко\s+в|ховайтесь|ховайся|сховайтесь|спускайтесь|коридор\p{L}*|в\s*укритт\p{L}*|до\s+укритт\p{L}*|на\s+укритт\p{L}*|в\s*укрыт\p{L}*|вибух\p{L}*|приліт\p{L}*|прильот\p{L}*)/iu;
export const isUrgentPost = (text) => URGENT.test(text) && !CLEAR.test(text);
export const isThreatPost = (text) => (THREAT.test(text) || URGENT.test(text)) && !CLEAR.test(text);

const tokens = (t) => new Set((t.toLowerCase().match(/[а-яіїєґa-z0-9']{3,}/g) || []));
/** Похожие сообщения из разных каналов об одном и том же: берём первое (кто быстрее написал), остальные пропускаем */
export function similar(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return false;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter) >= 0.45;
}

const keywordRe = () => new RegExp([...config.alertKeywords, ...config.alertPriority].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

/** Новые посты, касающиеся нашей области: baseline при первом запуске (старое не шлём) */
export async function fetchFlightPosts(now = Date.now(), fetchFn = fetch) {
  load();
  const re = keywordRe();
  const found = [];
  for (const ch of config.alertChannels) {
    try {
      const posts = parseChannel(await getText(`https://t.me/s/${ch}`, fetchFn), ch);
      if (!posts.length) continue;
      const last = S.posts[ch];
      S.posts[ch] = Math.max(...posts.map((p) => p.id), last || 0);
      if (last == null) continue; // первый запуск: запомнили, что уже было
      for (const p of posts) {
        if (p.id <= last || now - p.ts >= FRESH_MS || !isThreatPost(p.text)) continue;
        const local = config.alertLocal.includes(ch.toLowerCase());
        const urgentLocal = local && isUrgentPost(p.text); // «в укриття» в местном канале = летит на наш город
        if (!re.test(p.text) && !urgentLocal) continue;
        found.push({ ...p, channel: ch, priority: priorityRe().test(p.text) || urgentLocal });
      }
    } catch (e) {
      console.warn(`[alerts] канал ${ch}:`, e.message);
    }
  }
  persist();
  return found;
}

// ---------- рассылка ----------
const subscribed = () => allChats().filter(([id, st]) => id < 0 && st.settings?.alerts === true && !(st.kickedAt && (st.history.at(-1)?.ts ?? 0) < st.kickedAt));
const regionGen = () => config.alertRegion.replace(/ька область$/, 'ькій області').replace(/область$/, 'області');

const PIN_CLEAR_MS = 15 * 60_000; // отбой держим закреплённым ещё 15 минут и снимаем
const STALE_MS = 2 * H; // сообщения «летит» без тревоги и отбоя убираем через 2 часа

const track = (st, sent, kind) => (st.alertMsgs ||= []).push({ id: sent.message_id, at: Date.now(), kind });
const quiet = async (fn, what) => {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[alerts] ${what}:`, e.message); // нет прав админа (закреплять/удалять) или сообщение уже удалено
    return null;
  }
};
// закрепление с уведомлением: всем участникам приходит «закреплено сообщение»
const pin = (chatId, id) => quiet(() => app.telegram.pinChatMessage(chatId, id, { disable_notification: false }), 'закрепить');
const unpin = (chatId, id) => quiet(() => app.telegram.unpinChatMessage(chatId, id), 'открепить');

/** Удаляем сообщения тревоги (и из истории бота), чтобы чат не засорялся */
async function wipe(chatId, st, ids) {
  for (const id of ids) await quiet(() => app.telegram.deleteMessage(chatId, id), 'удалить');
  st.history = st.history.filter((m) => !ids.includes(m.id));
}

async function forEachChat(fn) {
  for (const [chatId, st] of subscribed()) {
    try {
      await fn(chatId, st);
    } catch (e) {
      console.error('[alerts]', chatId, e.message);
      if (/\b403\b|chat not found|bot was kicked|bot was blocked/i.test(e.message)) {
        st.kickedAt = Date.now();
      }
    }
  }
  save();
}

/** Тревога: пишем и закрепляем с уведомлением */
async function announceStart() {
  await forEachChat(async (chatId, st) => {
    if (st.alertPin) await unpin(chatId, st.alertPin); // старый закреплённый отбой больше не нужен
    st.alertPin = null;
    const sent = await say(chatId, st, startText());
    track(st, sent, 'start');
    if (await pin(chatId, sent.message_id)) st.alertPin = sent.message_id;
  });
}

/** Отбой: убираем всё про эту тревогу, оставляем только отбой (он закреплён на 15 минут) */
async function announceClear(mins, now = Date.now()) {
  await forEachChat(async (chatId, st) => {
    if (st.alertPin) await unpin(chatId, st.alertPin);
    st.alertPin = null;
    const ids = (st.alertMsgs || []).map((m) => m.id);
    st.alertMsgs = [];
    await wipe(chatId, st, ids);
    const sent = await say(chatId, st, clearText(mins));
    if (await pin(chatId, sent.message_id)) {
      st.alertPin = sent.message_id;
      st.alertUnpinAt = now + PIN_CLEAR_MS;
    }
  });
}

/** Снять закреп с отбоя и убрать «зависшие» сообщения без тревоги (например, пост про Кривой Рог без сирены) */
async function housekeeping(now) {
  await forEachChat(async (chatId, st) => {
    if (st.alertPin && st.alertUnpinAt && now >= st.alertUnpinAt) {
      await unpin(chatId, st.alertPin);
      st.alertPin = null;
      st.alertUnpinAt = 0;
    }
    if (!S.active && (st.alertMsgs || []).some((m) => now - m.at > STALE_MS)) {
      const ids = st.alertMsgs.map((m) => m.id);
      st.alertMsgs = [];
      await wipe(chatId, st, ids);
    }
  });
}

const cityName = () => (config.alertPriority[0] || 'наше місто');

export const startText = () => `🚨 ПОВІТРЯНА ТРИВОГА у ${regionGen()}!\nНегайно в укриття, не стійте біля вікон. Слухайте сирени та офіційні канали.`;
export const clearText = (mins) => `✅ ВІДБІЙ повітряної тривоги у ${regionGen()}.${mins >= 1 ? ` Тривога тривала ${mins >= 90 ? `${Math.floor(mins / 60)} год ${mins % 60} хв` : `${mins} хв`}.` : ''}`;

/** Раз в ~30 секунд: смена состояния тревоги и новые сообщения «где летит» */
export async function alertsTick(now = Date.now(), fetchFn = fetch) {
  if (botOff() || !app.telegram || !subscribed().length) return;
  load();
  const active = await fetchAlertState(fetchFn);
  if (active !== null) {
    if (S.active === null) {
      S.active = active; // первый запуск: просто запоминаем состояние
      S.since = now;
      persist();
    } else if (active !== S.active) {
      const mins = Math.round((now - S.since) / 60_000);
      S.active = active;
      S.since = now;
      persist();
      await (active ? announceStart() : announceClear(mins, now));
    }
  }
  if (now - lastChannelAt >= CHANNEL_EVERY_MS) {
    lastChannelAt = now;
    const posts = (await fetchFlightPosts(now, fetchFn)).sort((a, b) => a.ts - b.ts); // кто написал раньше, тот и «первый»
    for (const p of posts) {
      for (const [chatId, st] of subscribed()) {
        st.alertLog = (st.alertLog || []).filter((t) => now - t < H);
        st.alertSent = (st.alertSent || []).filter((x) => now - x.at < 15 * 60_000);
        if (st.alertSent.some((x) => similar(x.text, p.text))) continue; // то же самое уже писали из другого канала
        if (!p.priority) {
          if (st.alertLog.length >= HOURLY_CAP) continue; // обычные сообщения по области ограничены, про наш город почти без лимита
          st.alertLog.push(now);
        } else if (st.alertLog.length >= 4 * HOURLY_CAP) continue; // защита от потока в массированную атаку
        st.alertSent.push({ at: now, text: p.text });
        try {
          const sent = await say(chatId, st, p.priority ? `🚨🚨 УВАГА! Щось летить на ${cityName()}!\n\n${p.text}\n\nДжерело: ${p.link}` : `🛩 ${p.text}\n\nДжерело: ${p.link}`);
          track(st, sent, 'flight');
        } catch (e) {
          console.error('[alerts]', chatId, e.message);
        }
      }
    }
    save();
  }
  await housekeeping(now);
}

export function startAlerts() {
  setInterval(() => alertsTick().catch((e) => console.error('[alerts]', e.message)), 30_000);
}

/** Текст для /тревога и вопроса «есть тревога?»: состояние + последний пост про область */
export async function alertStatusText(fetchFn = fetch, now = Date.now()) {
  const active = await fetchAlertState(fetchFn);
  const head = active === null ? '⚠️ Не вдалося дізнатися стан тривоги (джерела недоступні). Орієнтуйтесь на сирени.' : active ? `🚨 У ${regionGen()} зараз ПОВІТРЯНА ТРИВОГА.` : `🟢 У ${regionGen()} зараз тривоги немає.`;
  let tail = '';
  try {
    const re = keywordRe();
    const posts = (await Promise.all(config.alertChannels.map(async (ch) => parseChannel(await getText(`https://t.me/s/${ch}`, fetchFn), ch)))).flat();
    const recent = posts.filter((p) => re.test(p.text) && now - p.ts < 3 * H).sort((a, b) => b.ts - a.ts);
    const last = recent.find((p) => priorityRe().test(p.text)) || recent[0];
    if (last) tail = `\n\n🛩 Останнє по області (${Math.max(1, Math.round((now - last.ts) / 60_000))} хв тому):\n${last.text}\n${last.link}`;
  } catch (e) {
    console.warn('[alerts] статус:', e.message);
  }
  return `${head}${tail}`;
}

export const isAlertQuestion = (text) => {
  const t = text || '';
  const alarm = /(?<!\p{L})(?:тревог\p{L}*|тривог\p{L}*|отбо\p{L}*|відбо\p{L}*|відбі\p{L}*|сирен\p{L}*)(?!\p{L})/iu.test(t);
  const flight = /(?<!\p{L})(?:где|де|куда|куди)(?!\p{L})/iu.test(t) && /(?<!\p{L})(?:лет\p{L}*|літ\p{L}*|ракет\p{L}*|шахед\p{L}*|бпла|дрон\p{L}*|мопед\p{L}*)/iu.test(t);
  return (alarm || flight) && /\?|есть|чи є|скажи|покажи|что там|шо там|сейчас|зараз/iu.test(t);
};
