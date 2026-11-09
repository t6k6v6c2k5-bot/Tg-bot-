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
const CHANNEL_EVERY_MS = 60_000;
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

const keywordRe = () => new RegExp(config.alertKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

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
      for (const p of posts) if (p.id > last && now - p.ts < FRESH_MS && re.test(p.text)) found.push({ ...p, channel: ch });
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

async function broadcast(text) {
  for (const [chatId, st] of subscribed()) {
    try {
      await say(chatId, st, text);
    } catch (e) {
      console.error('[alerts]', chatId, e.message);
      if (/\b403\b|chat not found|bot was kicked|bot was blocked/i.test(e.message)) {
        st.kickedAt = Date.now();
        save();
      }
    }
  }
}

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
      await broadcast(active ? startText() : clearText(mins));
    }
  }
  if (now - lastChannelAt >= CHANNEL_EVERY_MS) {
    lastChannelAt = now;
    for (const p of await fetchFlightPosts(now, fetchFn)) {
      for (const [chatId, st] of subscribed()) {
        st.alertLog = (st.alertLog || []).filter((t) => now - t < H);
        if (st.alertLog.length >= HOURLY_CAP) continue;
        st.alertLog.push(now);
        try {
          await say(chatId, st, `🛩 ${p.text}\n\nДжерело: ${p.link}`);
        } catch (e) {
          console.error('[alerts]', chatId, e.message);
        }
      }
    }
    save();
  }
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
    const last = posts.filter((p) => re.test(p.text) && now - p.ts < 3 * H).sort((a, b) => b.ts - a.ts)[0];
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
