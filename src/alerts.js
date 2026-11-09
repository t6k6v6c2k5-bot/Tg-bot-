import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { allChats, save } from './store.js';
import { app, say } from './respond.js';
import { botOff } from './owner.js';
import { alertsOn } from './botmode.js';

// Тревога именно в вашем городе: состояние берётся из постов канала вида «🔴 Криворізький район — повітряна тривога»
// и «🟢 Криворізький район — відбій повітряної тривоги». «Где летит» — из публичных каналов (t.me/s/<канал>).
// Только цитаты из источников, ничего не додумываем. Тревога не знает тихих часов.

const FILE = () => path.join(config.dataDir, 'alerts.json');
const STATE_URLS = { ubilling: 'https://ubilling.net.ua/aerialalerts/', alertscom: 'https://alerts.com.ua/api/states' };
const FRESH_MS = 20 * 60_000; // старые посты после простоя не пересылаем
const CHANNEL_EVERY_MS = 30_000;
const HOURLY_CAP = 10; // не больше N сообщений «где летит» в час на чат
const H = 3600_000;

let S = null; // { active: bool|null (тревога в городе), since: ts, posts: {канал: последний id}, areaPost: id }
let lastChannelAt = 0;
let lastNoSubLog = 0;

const load = () => {
  if (S) return S;
  try {
    S = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    S = { active: null, since: 0, posts: {} };
  }
  S.posts ||= {};
  S.areaPosts ||= {};
  return S;
};
const persist = () => {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify({ active: S.active, since: S.since, posts: S.posts, areaPosts: S.areaPosts }));
  } catch (e) {
    console.error('[alerts] не удалось сохранить:', e.message);
  }
};
export const _resetAlerts = () => {
  try {
    fs.unlinkSync(FILE());
  } catch {
    /* файла ещё нет */
  }
  S = null;
  lastChannelAt = 0;
  lastNoSubLog = 0;
};

async function getText(url, fetchFn) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; batya-bot)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

/** Запасной источник: идёт ли тревога во всей области (true/false) или null. Используется только в /тревога, если по городу данных нет. */
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

// Подписи каналов («Alerts Live • Зворотний зв'язок», «✉️chatbot|💬…», реклама) в чат не нужны
const SIGNATURE = /alerts\s*live|зворотн\p{L}*\s+зв.?язок|chatbot|treads|підписа\p{L}*|подписа\p{L}*|✉️|реклам\p{L}*|донат\p{L}*|t\.me\/|@\w+/iu;
export const cleanPost = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, a) => !SIGNATURE.test(l) && !(l === '' && (i === 0 || a[i - 1] === '')))
    .join('\n')
    .trim();

/** Посты из страницы t.me/s/<канал>: [{ id, text, ts, link }] (подписи каналов убраны) */
export function parseChannel(html, channel) {
  const out = [];
  for (const block of html.split('tgme_widget_message_wrap').slice(1)) {
    const post = block.match(/data-post="([^"/]+)\/(\d+)"/);
    const body = block.match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    const time = block.match(/<time[^>]*datetime="([^"]+)"/);
    if (!post || !body) continue;
    const raw = decode(body[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').trim();
    const text = cleanPost(raw);
    if (!text) continue;
    out.push({ id: Number(post[2]), text, ts: time ? Date.parse(time[1]) : 0, link: `https://t.me/${post[1]}/${post[2]}` });
  }
  return out.sort((a, b) => a.id - b.id);
}

const escRe = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const priorityRe = () => new RegExp(config.alertPriority.map(escRe).join('|'), 'i');
const keywordRe = () => new RegExp([...config.alertKeywords, ...config.alertPriority].map(escRe).join('|'), 'i');

// ---------- тревога в городе (район) ----------
const areaSrc = () => escRe(config.alertArea).replace(/\s+/g, '\\s+');
/** 'start' | 'end' | null — пост о тревоге/отбое именно по нашему району */
export function areaEvent(text) {
  const a = areaSrc();
  if (new RegExp(`${a}\\s*[—–-]\\s*відбій`, 'i').test(text)) return 'end';
  if (new RegExp(`${a}\\s*[—–-]\\s*(?:повітряна\\s+)?тривога`, 'i').test(text)) return 'start';
  return null;
}

// Подходит ли пост: про нашу область, про угрозу и это не «чисто / відбій / вийшов за межі»
const THREAT = /бпла|безпілот|дрон|шахед|геран|мопед|ракет|реактив|балістик|крилат|кинджал|калібр|іскандер|(?<![а-яa-z])х-\d|вибух|приліт|обстріл|ппо|літак|курс|напрям|транзит|вектор|груп[аиу]|ціль|цілі|летить|летять|рух/i;
// «Відбій» — только из поста по району (иначе дубли). А «чисто / без загроз / вийшов за межі / не зафіксовано» пишут, пока тревога ещё идёт: во время тревоги это важное обновление, без тревоги — шум.
const END = /відбій|відбо[юя]/i;
const SOFT = /чисто|без\s+загроз|вийшов\s+за\s+меж|вийшли\s+за\s+меж|залишив\s+(?:меж|област)|загроза\s+минула|не\s+загрожу|не\s+зафіксован/i;
const CLEAR = new RegExp(`${END.source}|${SOFT.source}`, 'i');
export const isUpdatePost = (text) => SOFT.test(text) && !END.test(text);
// Призывы укрыться: в местном канале это значит, что что-то летит на город
const URGENT = /(?<![а-яіїєґa-z])(?:терміново|негайно|срочно|швидко\s+в|ховайтесь|ховайся|сховайтесь|спускайтесь|коридор\p{L}*|в\s*укритт\p{L}*|до\s+укритт\p{L}*|на\s+укритт\p{L}*|в\s*укрыт\p{L}*|вибух\p{L}*|приліт\p{L}*|прильот\p{L}*)/iu;
export const isUrgentPost = (text) => URGENT.test(text) && !CLEAR.test(text);
export const isThreatPost = (text) => (THREAT.test(text) || URGENT.test(text)) && !CLEAR.test(text);

// Прямая угроза городу или просто движение рядом? «Транзит», «повз», «жовтий/жовтогарячий» — не повод кричать «УВАГА».
const TRANSIT = /транзит|повз|поблизу|вздовж|залишає|не\s+загрожу|на\s+(?:захід|схід|північ|південь)\s+від|жовтогаряч|жовтий|жовта/i;
const RED = /червон\p{L}*\s+рівен\p{L}*|червон\p{L}*\s+рівн\p{L}*|🟥|🔴/iu;
const DIRECT = /курсом\s+на|курс\s+на|в\s+напрямку|у\s+напрямку|на\s+Кривий|на\s+Кривого|прямує\s+на|летить\s+на|летять\s+на|заходить|над\s+(?:містом|Кривим)|у\s+бік\s+(?:міста|Кривого)|ціль[:\s]/iu;
const IMPACT = /вибух|приліт|влучанн|падінн/i;
/** Срочно (УВАГА, прямая угроза городу) или обычное сообщение о движении поблизости */
export function isDirectThreat(text) {
  if (IMPACT.test(text) || RED.test(text)) return true;
  if (TRANSIT.test(text)) return false;
  return DIRECT.test(text);
}

// Ракеты — срочно в укрытие; БпЛА/дроны — без паники, просто что и куда летит.
const MISSILE = /ракет|балістик|крилат|кинджал|калібр|іскандер|(?<![а-яa-z])х-\d|(?<![а-яa-z])кх-\d|циркон|онікс/i;
const OBLAST = /дніпропетровщин|дніпропетровськ/i;
/** Ракетная угроза нашему городу или области в целом (а не соседнему городу) */
export const isMissileThreat = (text, local = false) => MISSILE.test(text) && !CLEAR.test(text) && (priorityRe().test(text) || OBLAST.test(text) || local);

const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
/** Причина тревоги: самый свежий пост об угрозе по городу/области за последние 30 минут */
export function reasonFrom(pages, now = Date.now()) {
  if (!pages) return null;
  const re = keywordRe();
  const posts = config.alertChannels
    .flatMap((ch) => (pages[ch] || []).map((p) => ({ ...p, local: config.alertLocal.includes(ch.toLowerCase()) })))
    .filter((p) => now - p.ts < 30 * 60_000 && !areaEvent(p.text) && isThreatPost(p.text) && (re.test(p.text) || (p.local && isUrgentPost(p.text))))
    .sort((a, b) => b.ts - a.ts);
  const missile = posts.find((p) => isMissileThreat(p.text, p.local));
  const pick = missile || posts[0];
  return pick ? { text: clip(pick.text.replace(/\s+/g, ' '), 220), missile: Boolean(missile) } : null;
}

const tokens = (t) => new Set(t.toLowerCase().match(/[а-яіїєґa-z0-9']{3,}/g) || []);
/** Похожие сообщения из разных каналов об одном и том же: берём первое (кто быстрее написал), остальные пропускаем */
export function similar(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return false;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter) >= 0.45;
}

/** Страницы всех нужных каналов: { канал: [посты] } */
async function fetchPages(fetchFn) {
  const pages = {};
  for (const ch of new Set([...config.alertChannels, ...config.alertAreaChannels])) {
    try {
      pages[ch] = parseChannel(await getText(`https://t.me/s/${ch}`, fetchFn), ch);
    } catch (e) {
      console.warn(`[alerts] канал ${ch}:`, e.message);
    }
  }
  return pages;
}

// ---------- рассылка ----------
const subscribed = () => allChats().filter(([id, st]) => id < 0 && alertsOn(st) && !(st.kickedAt && (st.history.at(-1)?.ts ?? 0) < st.kickedAt));
const label = () => config.alertAreaLabel;

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
      if (/\b403\b|chat not found|bot was kicked|bot was blocked/i.test(e.message)) st.kickedAt = Date.now();
    }
  }
  save();
}

const cityName = () => config.alertPriority[0] || 'наше місто';

// ---------- оформление: «карточки» (заголовок жирным, суть в цитате, источник ссылкой) ----------
const hhmm = (ts) => new Intl.DateTimeFormat('uk-UA', { timeZone: config.outageTz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);

/** Собирает текст и entities из строк: {bold}, {quote}, {source:{name,link,time}} или {text} */
export function card(lines) {
  let text = '';
  const entities = [];
  lines
    .filter(Boolean)
    .forEach((l, i) => {
      if (i) text += '\n';
      if (l.bold) {
        entities.push({ type: 'bold', offset: text.length, length: l.bold.length });
        text += l.bold;
      } else if (l.quote) {
        entities.push({ type: 'blockquote', offset: text.length, length: l.quote.length });
        text += l.quote;
      } else if (l.source) {
        text += '📡 ';
        entities.push({ type: 'text_link', offset: text.length, length: l.source.name.length, url: l.source.link });
        text += l.source.name + (l.source.time ? ` · ${l.source.time}` : '');
      } else text += l.text;
    });
  return { text, entities };
}
const place = () => ({ text: `📍 ${cityName()}` });
const sourceLine = (p) => ({ source: { name: p.channel || p.link.split('/')[3], link: p.link, time: hhmm(p.ts) } });

/** Тревога: ракеты → срочно в укрытие; БпЛА и остальное → без паники, просто причина */
export const startText = (reason = null, now = Date.now()) =>
  card([
    { bold: '🚨 ПОВІТРЯНА ТРИВОГА' },
    place(),
    reason?.missile && { bold: '🚀 Ракетна загроза: терміново в укриття!' },
    { quote: `Причина: ${reason ? reason.text : 'уточнюється, слідкуйте за повідомленнями.'}` },
    { text: `🕐 з ${hhmm(now)}` },
  ]);
export const clearText = (mins) => card([{ bold: '✅ ВІДБІЙ ТРИВОГИ' }, place(), mins >= 1 && { text: `⏱ тривала ${mins >= 90 ? `${Math.floor(mins / 60)} год ${mins % 60} хв` : `${mins} хв`}` }]);
export const idleText = () => card([{ bold: '🟢 ТРИВОГИ НЕМАЄ' }, place()]);

/** Сообщение «где летит» одним из видов: ракеты, срочно, обновление, обычное */
export function flightCard(p) {
  const head = p.missile ? [{ bold: '🚀 РАКЕТНА ЗАГРОЗА' }, place(), { bold: '‼️ Терміново в укриття!' }] : p.urgent ? [{ bold: '🚨 УВАГА' }, place()] : p.update ? [{ bold: 'ℹ️ ОНОВЛЕННЯ' }] : [{ bold: priorityRe().test(p.text) ? '🛩 РУХ ПОБЛИЗУ' : '🛩 РУХ ПО ОБЛАСТІ' }];
  return card([...head, { quote: p.text }, sourceLine(p)]);
}

/**
 * Закреплённое сообщение чата всегда показывает актуальное состояние: «ТРИВОГА» или «ВІДБІЙ / тривоги немає».
 * Новое состояние = новое сообщение (закрепляется с уведомлением), старое откреплено и удалено, чат чистый.
 * @param {boolean} active  тревога идёт
 * @param {{mins?:number, now?:number, initial?:boolean}} o  initial — просто привести закреп в соответствие (без «отбоя» из ниоткуда)
 */
async function postStatus(chatId, st, active, { mins = 0, now = Date.now(), initial = false, reason = null } = {}) {
  const old = st.alertStatus;
  if (old?.id) await unpin(chatId, old.id);
  if (st.alertPin && st.alertPin !== old?.id) await unpin(chatId, st.alertPin);
  st.alertPin = null;
  const ids = new Set((st.alertMsgs || []).map((m) => m.id));
  if (!active && old?.id) ids.add(old.id); // отбой вытесняет и тревогу, и все «летит…»
  if (active && old && !old.active) ids.add(old.id); // новая тревога убирает старый отбой
  st.alertMsgs = [];
  await wipe(chatId, st, [...ids]);
  const msg = active ? startText(reason, now) : initial ? idleText() : clearText(mins);
  const sent = await say(chatId, st, msg.text, undefined, { entities: msg.entities, noPreview: true });
  if (active) track(st, sent, 'start');
  st.alertStatus = { id: sent.message_id, active, at: now };
  // тревога и отбой закрепляются с уведомлением; «просто нет тревоги» при подключении чата — тихо
  const notify = active || !initial;
  if (await quiet(() => app.telegram.pinChatMessage(chatId, sent.message_id, { disable_notification: !notify }), 'закрепить')) st.alertPin = sent.message_id;
}

const announceStart = (reason) => forEachChat((chatId, st) => postStatus(chatId, st, true, { reason }));
const announceClear = (mins, now) => forEachChat((chatId, st) => postStatus(chatId, st, false, { mins, now }));

/** Привести закреп в каждом чате в соответствие с текущим состоянием (новый чат, перезапуск, пропущенное событие) */
async function ensureStatus(now, pages = null) {
  const active = S.active === true;
  await forEachChat(async (chatId, st) => {
    if (st.alertStatus && st.alertStatus.active === active) return;
    await postStatus(chatId, st, active, { initial: true, now, reason: active ? reasonFrom(pages, now) : null });
  });
}

/** Убрать «зависшие» сообщения «летит» без тревоги (например, пост про город без сирены) */
async function housekeeping(now) {
  await forEachChat(async (chatId, st) => {
    if (!S.active && (st.alertMsgs || []).some((m) => now - m.at > STALE_MS)) {
      const ids = st.alertMsgs.map((m) => m.id);
      st.alertMsgs = [];
      await wipe(chatId, st, ids);
    }
  });
}

/** Смена состояния тревоги в городе по постам каналов: первый запуск запоминает состояние молча */
async function processArea(pages, now) {
  const events = [];
  for (const ch of config.alertAreaChannels) {
    const posts = pages[ch];
    if (!posts?.length) continue;
    const last = S.areaPosts[ch];
    S.areaPosts[ch] = Math.max(...posts.map((p) => p.id), last || 0);
    for (const p of posts) {
      const ev = areaEvent(p.text);
      if (ev && (last == null || p.id > last)) events.push({ ...p, ev });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  const baseline = S.active === null;
  for (const e of events) {
    const active = e.ev === 'start';
    if (S.active === active) continue; // повтор того же состояния («красный уровень» повторно и т. п.)
    const mins = Math.round((e.ts - S.since) / 60_000);
    const wasNull = S.active === null;
    S.active = active;
    S.since = e.ts;
    // без тревоги в памяти (первый запуск) или пост устарел (простой бота) — только запоминаем
    if (wasNull || now - e.ts > FRESH_MS) continue;
    console.log(`[alerts] ${active ? 'ТРИВОГА' : 'ОТБОЙ'} в ${label()}, чатов: ${subscribed().length}`);
    persist();
    await (active ? announceStart(reasonFrom(pages, now)) : announceClear(Math.max(0, mins), now));
  }
  if (baseline && S.active === null) S.active = false; // постов по району не нашли: считаем, что тревоги нет
  persist();
}

/** Новые посты «где летит»: baseline при первом запуске (старое не шлём) */
function pickFlightPosts(pages, now) {
  const re = keywordRe();
  const active = S.active === true;
  const found = [];
  for (const ch of config.alertChannels) {
    const posts = pages[ch];
    if (!posts?.length) continue;
    const last = S.posts[ch];
    S.posts[ch] = Math.max(...posts.map((p) => p.id), last || 0);
    if (last == null) continue; // первый запуск: запомнили, что уже было
    const local = config.alertLocal.includes(ch.toLowerCase());
    for (const p of posts) {
      if (p.id <= last || now - p.ts >= FRESH_MS || areaEvent(p.text)) continue; // посты о тревоге по району — это состояние, не «летит»
      if (!isThreatPost(p.text)) {
        // «чисто / вийшов за межі / без загроз» во время тревоги — обновление, без тревоги — пропускаем
        if (active && isUpdatePost(p.text) && (re.test(p.text) || local)) found.push({ ...p, channel: ch, priority: false, update: true });
        continue;
      }
      const urgentLocal = local && isUrgentPost(p.text); // «в укриття» в местном канале = летит на наш город
      if (!re.test(p.text) && !urgentLocal) continue;
      const missile = isMissileThreat(p.text, local);
      // срочный «УВАГА» только для ракет, взрывов/прилётов и призыва укрыться из местного канала; БпЛА — обычное сообщение без паники
      const urgent = missile || urgentLocal || (priorityRe().test(p.text) && IMPACT.test(p.text));
      found.push({ ...p, channel: ch, priority: urgent || (priorityRe().test(p.text) && isDirectThreat(p.text)), urgent, missile });
    }
  }
  persist();
  return found.sort((a, b) => a.ts - b.ts); // кто написал раньше, тот и «первый»
}

/** Раз в ~30 секунд: смена состояния тревоги в городе и новые сообщения «где летит» */
export async function alertsTick(now = Date.now(), fetchFn = fetch) {
  if (botOff() || !app.telegram) return;
  if (!subscribed().length) {
    if (now - lastNoSubLog > 30 * 60_000) {
      lastNoSubLog = now;
      console.log('[alerts] нет чатов с включёнными тревогами: включи /тревога вкл в чате или режим «свет и тревога»');
    }
    return;
  }
  load();
  if (now - lastChannelAt >= CHANNEL_EVERY_MS) {
    lastChannelAt = now;
    const pages = await fetchPages(fetchFn);
    await processArea(pages, now);
    await ensureStatus(now, pages);
    for (const p of pickFlightPosts(pages, now)) {
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
          const m = flightCard(p);
          const sent = await say(chatId, st, m.text, undefined, { entities: m.entities, noPreview: true });
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

/** Карточка для /тревога и вопроса «есть тревога?»: состояние по городу + последний пост про него */
export async function alertStatusText(fetchFn = fetch, now = Date.now()) {
  load();
  const pages = await fetchPages(fetchFn);
  // состояние по городу: последний пост по району среди каналов
  const area = config.alertAreaChannels
    .flatMap((ch) => (pages[ch] || []).map((p) => ({ ...p, ev: areaEvent(p.text) })))
    .filter((p) => p.ev)
    .sort((a, b) => b.ts - a.ts)[0];
  let head;
  if (area) head = [{ bold: area.ev === 'start' ? '🚨 ПОВІТРЯНА ТРИВОГА' : '🟢 ТРИВОГИ НЕМАЄ' }, place(), area.ev === 'start' && { text: `🕐 з ${hhmm(area.ts)}` }];
  else {
    // по городу данных нет — честно говорим и показываем область
    const oblast = await fetchAlertState(fetchFn);
    head = [
      { bold: oblast === null ? '⚠️ СТАН НЕВІДОМИЙ' : 'ℹ️ ДАНИХ ПО МІСТУ НЕМАЄ' },
      place(),
      { text: oblast === null ? 'Джерела недоступні, орієнтуйтесь на сирени.' : `У ${config.alertRegion.replace(/ька область$/, 'ькій області')}: ${oblast ? 'тривога' : 'тривоги немає'}.` },
    ];
  }
  let tail = [];
  try {
    const re = keywordRe();
    const posts = Object.entries(pages)
      .filter(([ch]) => config.alertChannels.includes(ch))
      .flatMap(([ch, ps]) => ps.map((p) => ({ ...p, channel: ch })))
      .filter((p) => !areaEvent(p.text) && re.test(p.text) && now - p.ts < 3 * H)
      .sort((a, b) => b.ts - a.ts);
    const last = posts.find((p) => priorityRe().test(p.text)) || posts[0];
    if (last) tail = [{ text: `🛩 Останнє · ${Math.max(1, Math.round((now - last.ts) / 60_000))} хв тому` }, { quote: last.text }, sourceLine(last)];
  } catch (e) {
    console.warn('[alerts] статус:', e.message);
  }
  return card([...head, ...tail]);
}

export const isAlertQuestion = (text) => {
  const t = text || '';
  const alarm = /(?<!\p{L})(?:тревог\p{L}*|тривог\p{L}*|отбо\p{L}*|відбо\p{L}*|відбі\p{L}*|сирен\p{L}*)(?!\p{L})/iu.test(t);
  const flight = /(?<!\p{L})(?:где|де|куда|куди)(?!\p{L})/iu.test(t) && /(?<!\p{L})(?:лет\p{L}*|літ\p{L}*|ракет\p{L}*|шахед\p{L}*|бпла|дрон\p{L}*|мопед\p{L}*)/iu.test(t);
  return (alarm || flight) && /\?|есть|чи є|скажи|покажи|что там|шо там|сейчас|зараз/iu.test(t);
};
