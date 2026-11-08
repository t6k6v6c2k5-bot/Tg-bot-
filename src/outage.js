import crypto from 'node:crypto';
import { config } from './config.js';
import { allChats, hourOf, dayKey, save } from './store.js';
import { app, say } from './respond.js';
import { botOff } from './owner.js';

// Графики отключений света из https://github.com/Baskerville42/outage-data-ua
// data/<регион>.json — данные по очередям (GPV3.1 …), images/<регион>/gpv-3-1.png — готовая картинка.

const RAW = () => `https://raw.githubusercontent.com/${config.outageRepo}/${config.outageBranch}`;
const POLL_MS = 10 * 60_000;
const CACHE_MS = 5 * 60_000;

let cache = { at: 0, data: null };
let lastPoll = 0;

async function getBuffer(url, fetchFn) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function loadData(fetchFn = fetch, now = Date.now()) {
  if (cache.data && now - cache.at < CACHE_MS) return cache.data;
  const buf = await getBuffer(`${RAW()}/data/${config.outageRegion}.json`, fetchFn);
  cache = { at: now, data: JSON.parse(buf.toString('utf8')) };
  return cache.data;
}

export const _resetOutageCache = () => {
  cache = { at: 0, data: null };
  lastPoll = 0;
};

/** Очереди, которые есть в данных: ['GPV1.1', 'GPV3.2', …] */
export function listGroups(data) {
  const set = new Set();
  for (const day of Object.values(data?.fact?.data || {})) for (const g of Object.keys(day || {})) set.add(g);
  return [...set].sort((a, b) => parseFloat(a.slice(3)) - parseFloat(b.slice(3)) || a.localeCompare(b));
}

/** «3.1», «3,1», «3-1», «gpv3.1», «ГПВ 3 1» → 'GPV3.1' (или null) */
export function parseGroup(input, known = null) {
  const m = String(input || '').match(/(?:gpv|гпв|черг\p{L}*|очеред\p{L}*)?\s*(\d{1,2})\s*[.,\-_\s]\s*(\d)(?!\d)/iu);
  if (!m) return null;
  const g = `GPV${Number(m[1])}.${m[2]}`;
  return !known || known.includes(g) ? g : null;
}

export const shortName = (g) => g.replace(/^GPV/, '');
export const imageUrl = (g) => `${RAW()}/images/${config.outageRegion}/${g.toLowerCase().replace('gpv', 'gpv-').replace('.', '-')}.png`;

/** Отпечаток графика очереди (сегодня + завтра): меняется, когда меняется расписание */
export function groupHash(data, g) {
  const days = Object.entries(data?.fact?.data || {})
    .sort(([a], [b]) => a - b)
    .map(([ts, v]) => [ts, v?.[g] ?? null]);
  return crypto.createHash('sha1').update(JSON.stringify(days)).digest('hex').slice(0, 12);
}

const updated = (data) => data?.fact?.update || data?.fact?.updateFact || '';

// ---------- расписание в человеческом виде ----------
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Интервалы без света за день: {off:[[с,по]…], maybe:[[с,по]…]} в минутах. Час i (1..24) = (i-1):00–i:00; first/second — первая/вторая половина часа. */
export function offIntervals(sched) {
  const off = [];
  const maybe = [];
  for (let h = 1; h <= 24; h++) {
    const s = (h - 1) * 60;
    const st = sched?.[String(h)];
    if (st === 'no') off.push([s, s + 60]);
    else if (st === 'first' || st === 'mfirst') off.push([s, s + 30]);
    else if (st === 'second' || st === 'msecond') off.push([s + 30, s + 60]);
    else if (st === 'maybe') maybe.push([s, s + 60]);
  }
  const merge = (arr) => {
    const out = [];
    for (const [a, b] of arr) {
      if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  return { off: merge(off), maybe: merge(maybe) };
}

const fmt = (iv) => iv.map(([a, b]) => `${hhmm(a)}–${hhmm(b)}`).join(', ');

/** Строки по очереди: сегодня и завтра (если уже есть в данных) */
export function dayLines(data, g, now = Date.now()) {
  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(now + 24 * 3600_000);
  const out = [];
  for (const [ts, groups] of Object.entries(data?.fact?.data || {}).sort(([a], [b]) => a - b)) {
    const k = dayKey(Number(ts) * 1000);
    const label = k === todayKey ? 'сьогодні' : k === tomorrowKey ? 'завтра' : null;
    if (!label || !groups?.[g]) continue;
    const { off, maybe } = offIntervals(groups[g]);
    const parts = [];
    parts.push(off.length ? `світла не буде ${fmt(off)}` : 'відключень немає');
    if (maybe.length) parts.push(`можливо ${fmt(maybe)}`);
    out.push(`${label}: ${parts.join('; ')}`);
  }
  return out;
}

/**
 * Сообщение по очередям: «Черга 3.1 (Влад, Саша)» и строки по дням. tag=true — люди тегаются (придёт уведомление).
 * @returns {{text:string, entities:object[]}}
 */
export function buildMessage(data, byGroup, { title, tag = false, now = Date.now() } = {}) {
  let text = title ? `${title}\n` : '';
  const entities = [];
  for (const [g, people] of Object.entries(byGroup)) {
    text += `\n💡 Черга ${shortName(g)} (`;
    people.forEach((p, i) => {
      if (i) text += ', ';
      if (tag && !p.username) entities.push({ type: 'text_mention', offset: text.length, length: p.name.length, user: { id: Number(p.uid) } });
      text += tag && p.username ? `@${p.username}` : p.name;
    });
    text += ')\n';
    const lines = dayLines(data, g, now);
    text += lines.length ? lines.map((l) => `• ${l}`).join('\n') : '• даних поки немає';
    text += '\n';
  }
  return { text: text.trimEnd(), entities };
}

async function sendImage(chatId, g, data, fetchFn = fetch) {
  const buf = await getBuffer(imageUrl(g), fetchFn);
  await app.telegram.sendPhoto(chatId, { source: buf }, { caption: `💡 Черга ${shortName(g)}${updated(data) ? ` · оновлено ${updated(data)}` : ''}` });
}

const sub = (st) => {
  const o = (st.outage ||= {});
  o.users ||= {}; // uid -> { group, name, username }
  o.hashes ||= {}; // группа -> отпечаток последнего отправленного графика
  o.morningDay ||= '';
  return o;
};

/** Люди чата по очередям: { 'GPV3.1': [{uid, name, username}] } */
export function peopleByGroup(o) {
  const by = {};
  for (const [uid, u] of Object.entries(o.users)) (by[u.group] ||= []).push({ uid, name: u.name, username: u.username });
  return by;
}

/** Запомнить очередь человека (вызывается и из фразы «моя очередь 3.1») */
export function setUserGroup(st, from, g, data = null) {
  const o = sub(st);
  o.users[from.id] = { group: g, name: from.first_name || from.username || 'друг', username: from.username };
  if (data) o.hashes[g] = groupHash(data, g);
}

/** «моя черга 3.1», «у меня очередь 4.2» → 'GPV3.1' (или null) */
export const parseMyQueue = (text) => {
  const m = String(text || '').match(/(?:мо[яеёй]\w*|у\s+мен[яе]|моя)\s+(?:черга|очередь|групп\p{L}*)\s*(?:№|номер|це)?\s*(\d{1,2}\s*[.,\-]\s*\d)(?!\d)/iu) || String(text || '').match(/(?:черга|очередь)\s+(?:у\s+мен[яе]|мо[яеёй]\w*)\s*(\d{1,2}\s*[.,\-]\s*\d)(?!\d)/iu);
  return m ? parseGroup(m[1]) : null;
};

/** /свет 3.1 — запомнить мою очередь и показать график; /свет — мой график; /свет стоп — забыть; /свет картинка — картинкой */
export async function outageCommand(chatId, st, args, replyTo, from, fetchFn = fetch) {
  const o = sub(st);
  const reply = (t, meta) => say(chatId, st, t, replyTo, meta);
  let data;
  try {
    data = await loadData(fetchFn);
  } catch (e) {
    console.warn('[outage]', e.message);
    return void (await reply('Не дотягуюсь до графіків, спробуй трохи пізніше.'));
  }
  const known = listGroups(data);
  const mine = o.users[from.id]?.group;
  const text = (args || '').trim();
  if (/^(?:стоп|stop|off|выкл|вимкн|отпис|забудь|видал)/iu.test(text)) {
    delete o.users[from.id];
    save();
    return void (await reply('Забув твою чергу, графіки для тебе більше не кидаю.'));
  }
  const wantImage = /(?:картин|графік|график|png|фото)/iu.test(text);
  const g = parseGroup(text, known) || (!parseGroup(text) && (!text || wantImage) ? mine : null);
  if (!g) {
    if (text && !parseGroup(text)) return void (await reply(`Не розумію чергу. Пиши так: /свет 3.1. Є черги: ${known.map(shortName).join(', ')}.`));
    if (!text) return void (await reply(`Я не знаю твою чергу. Напиши /свет 3.1 (або "моя черга 3.1"), запам'ятаю, і сам кидатиму тобі графік вранці та коли він зміниться. Є черги: ${known.map(shortName).join(', ')}.`));
    return void (await reply(`Такої черги нема. Є: ${known.map(shortName).join(', ')}.`));
  }
  if (!wantImage || parseGroup(text)) setUserGroup(st, from, g, data);
  save();
  if (wantImage) {
    try {
      return void (await sendImage(chatId, g, data, fetchFn));
    } catch (e) {
      console.warn('[outage] картинка', e.message);
    }
  }
  const msg = buildMessage(data, { [g]: [{ uid: from.id, name: from.first_name || from.username || 'друг', username: from.username }] }, {
    title: mine === g || !parseGroup(text) ? '' : "Запам'ятав твою чергу, далі кидатиму вранці і коли графік зміниться.",
  });
  await reply(msg.text);
}

const isQuiet = (hour) => (config.quietFrom <= config.quietTo ? hour >= config.quietFrom && hour < config.quietTo : hour >= config.quietFrom || hour < config.quietTo);

/** Раз в минуту из планировщика: утренний график и сообщение при изменении (ночью не будим — всё придёт утром). */
export async function outageTick(now = Date.now(), fetchFn = fetch) {
  if (botOff() || !app.telegram) return;
  const chats = allChats().filter(([id, st]) => id < 0 && st.outage?.users && Object.keys(st.outage.users).length && !(st.kickedAt && (st.history.at(-1)?.ts ?? 0) < st.kickedAt));
  if (!chats.length || now - lastPoll < POLL_MS) return;
  lastPoll = now;
  const data = await loadData(fetchFn, now);
  const hour = hourOf(now);
  const today = dayKey(now);
  for (const [chatId, st] of chats) {
    const o = sub(st);
    const by = peopleByGroup(o);
    try {
      if (hour >= config.outageHour && o.morningDay !== today && !isQuiet(hour)) {
        o.morningDay = today;
        for (const g of Object.keys(by)) o.hashes[g] = groupHash(data, g);
        save();
        const m = buildMessage(data, by, { title: 'Доброго ранку! Світло на сьогодні:', now });
        await say(chatId, st, m.text);
      } else if (!isQuiet(hour)) {
        const changed = Object.keys(by).filter((g) => o.hashes[g] !== groupHash(data, g));
        if (changed.length) {
          const sel = Object.fromEntries(changed.map((g) => [g, by[g]]));
          for (const g of changed) o.hashes[g] = groupHash(data, g);
          save();
          const m = buildMessage(data, sel, { title: 'Графік змінився:', tag: true, now });
          await say(chatId, st, m.text, undefined, m.entities.length ? { entities: m.entities } : {});
        }
      }
    } catch (e) {
      console.error('[outage]', chatId, e.message);
      if (/\b403\b|chat not found|bot was kicked|bot was blocked/i.test(e.message)) {
        st.kickedAt = Date.now();
        save();
      }
    }
  }
}
