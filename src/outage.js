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
const MAX_ALBUM = 10;

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
const caption = (g, data, note = '') => `💡 Черга ${shortName(g)}${updated(data) ? ` · оновлено ${updated(data)}` : ''}${note ? `\n${note}` : ''}`;

async function sendGraphs(chatId, groups, data, note, fetchFn = fetch) {
  const shots = [];
  for (const g of groups) {
    try {
      shots.push({ g, buf: await getBuffer(imageUrl(g), fetchFn) });
    } catch (e) {
      console.warn('[outage] нет картинки', g, e.message);
    }
  }
  if (!shots.length) return 0;
  for (let i = 0; i < shots.length; i += MAX_ALBUM) {
    const part = shots.slice(i, i + MAX_ALBUM);
    if (part.length === 1) {
      await app.telegram.sendPhoto(chatId, { source: part[0].buf }, { caption: caption(part[0].g, data, note) });
    } else {
      await app.telegram.sendMediaGroup(
        chatId,
        part.map(({ g, buf }) => ({ type: 'photo', media: { source: buf }, caption: caption(g, data, note) })),
      );
    }
  }
  return shots.length;
}

const sub = (st) => (st.outage ||= { groups: {}, morningDay: '' });

/** /свет 3.1 — подключить очередь и сразу прислать график; /свет стоп 3.1 — отключить; /свет — список */
export async function outageCommand(chatId, st, args, replyTo, fetchFn = fetch) {
  const o = sub(st);
  const reply = (t) => say(chatId, st, t, replyTo);
  let data;
  try {
    data = await loadData(fetchFn);
  } catch (e) {
    console.warn('[outage]', e.message);
    return void (await reply('Не дотягуюсь до графиков, спробуй трохи пізніше.'));
  }
  const known = listGroups(data);
  const connected = Object.keys(o.groups);
  const text = (args || '').trim();
  if (/^(?:стоп|stop|off|выкл|вимкн|отпис|видал)/iu.test(text)) {
    const g = parseGroup(text);
    if (g) delete o.groups[g];
    else o.groups = {};
    save();
    return void (await reply(g ? `Черга ${shortName(g)} відключена.` : 'Усі черги відключені, графіки сам не кидаю.'));
  }
  if (!text) {
    const list = connected.length ? `Підключені черги: ${connected.map(shortName).join(', ')}.` : 'Жодна черга не підключена.';
    return void (await reply(`${list}\nПодключити: /свет 3.1 (прийде графік зараз, далі вранці і коли він зміниться). Є черги: ${known.map(shortName).join(', ')}.`));
  }
  const g = parseGroup(text, known);
  if (!g) return void (await reply(`Не розумію чергу. Пиши так: /свет 3.1. Є черги: ${known.map(shortName).join(', ')}.`));
  o.groups[g] = { hash: groupHash(data, g) };
  save();
  const n = await sendGraphs(chatId, [g], data, connected.includes(g) ? '' : 'Підключено: кидатиму вранці і коли графік зміниться.', fetchFn);
  if (!n) await reply('Графік для цієї черги зараз недоступний, спробуй пізніше.');
}

const isQuiet = (hour) => (config.quietFrom <= config.quietTo ? hour >= config.quietFrom && hour < config.quietTo : hour >= config.quietFrom || hour < config.quietTo);

/** Раз в минуту из планировщика: утренний график и сообщение при изменении (ночью не будим — всё придёт утром). */
export async function outageTick(now = Date.now(), fetchFn = fetch) {
  if (botOff() || !app.telegram) return;
  const chats = allChats().filter(([id, st]) => id < 0 && st.outage && Object.keys(st.outage.groups).length && !(st.kickedAt && (st.history.at(-1)?.ts ?? 0) < st.kickedAt));
  if (!chats.length || now - lastPoll < POLL_MS) return;
  lastPoll = now;
  const data = await loadData(fetchFn, now);
  const hour = hourOf(now);
  const today = dayKey(now);
  for (const [chatId, st] of chats) {
    const o = st.outage;
    const hashes = Object.fromEntries(Object.keys(o.groups).map((g) => [g, groupHash(data, g)]));
    try {
      if (hour >= config.outageHour && o.morningDay !== today && !isQuiet(hour)) {
        o.morningDay = today;
        for (const g of Object.keys(o.groups)) o.groups[g].hash = hashes[g];
        save();
        await sendGraphs(chatId, Object.keys(o.groups), data, 'Доброго ранку, ось графік.', fetchFn);
      } else if (!isQuiet(hour)) {
        const changed = Object.keys(o.groups).filter((g) => o.groups[g].hash !== hashes[g]);
        if (changed.length) {
          for (const g of changed) o.groups[g].hash = hashes[g];
          save();
          await sendGraphs(chatId, changed, data, 'Графік змінився.', fetchFn);
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
