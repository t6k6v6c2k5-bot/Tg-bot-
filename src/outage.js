import crypto from 'node:crypto';
import { config } from './config.js';
import { allChats, hourOf, dayKey, save } from './store.js';
import { app, say } from './respond.js';
import { botOff } from './owner.js';

// Графики отключений света из https://github.com/Baskerville42/outage-data-ua
// data/<регион>.json — данные по очередям (GPV3.1 …), images/<регион>/gpv-3-1.png — готовая картинка.

const RAW = () => `https://raw.githubusercontent.com/${config.outageRepo}/${config.outageBranch}`;
const POLL_MS = 3 * 60_000; // новый график должен прийти в чат почти сразу
const CACHE_MS = 2 * 60_000;

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
export const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

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

/** Сегодня и завтра из данных: [{label, date:'09.11', groups}] */
export function daysOf(data, now = Date.now()) {
  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(now + 24 * 3600_000);
  const out = [];
  for (const [ts, groups] of Object.entries(data?.fact?.data || {}).sort(([a], [b]) => a - b)) {
    const k = dayKey(Number(ts) * 1000);
    const label = k === todayKey ? 'Сьогодні' : k === tomorrowKey ? 'Завтра' : null;
    if (!label) continue;
    const date = new Date(Number(ts) * 1000).toLocaleDateString('uk-UA', { timeZone: config.tz, day: '2-digit', month: '2-digit' });
    out.push({ label, date, groups: groups || {} });
  }
  return out;
}

const hoursOff = (iv) => {
  const h = Math.round(iv.reduce((n, [x, y]) => n + (y - x), 0) / 6) / 10;
  return `${String(h).replace('.', ',')} год`;
};

/**
 * Красивая сводка по очередям: по дням (цитата), очереди с одинаковым графиком склеены в одну строку,
 * рядом имена людей, у кого она записана. Жирный/цитата — через entities.
 * changed — очереди, у которых график поменялся: помечаются 🔄, их люди тегаются (придёт уведомление).
 * only — показать только эти очереди (личный /свет).
 * @returns {{text:string, entities:object[]}}
 */
export function buildSummary(data, people, { title, subtitle = '', days = ['Сьогодні', 'Завтра'], changed = new Set(), only = null, now = Date.now() } = {}) {
  let text = '';
  const entities = [];
  const add = (str, type) => {
    if (type) entities.push({ type, offset: text.length, length: str.length });
    text += str;
  };
  add(title, 'bold');
  if (subtitle) text += `\n${subtitle}`;
  const sections = daysOf(data, now).filter((d) => days.includes(d.label));
  for (const d of sections) {
    // склеиваем очереди с одинаковым графиком
    const blocks = new Map();
    for (const g of listGroups({ fact: { data: { x: d.groups } } })) {
      if (only && !only.includes(g)) continue;
      const iv = offIntervals(d.groups[g]);
      const key = JSON.stringify(iv);
      if (!blocks.has(key)) blocks.set(key, { iv, groups: [] });
      blocks.get(key).groups.push(g);
    }
    text += '\n\n';
    add(`📅 ${d.label} · ${d.date}`, 'bold');
    text += '\n';
    const quoteFrom = text.length;
    let first = true;
    for (const { iv, groups } of blocks.values()) {
      if (!first) text += '\n\n';
      first = false;
      const hit = groups.some((g) => changed.has(g));
      text += `${hit ? '🔄' : iv.off.length ? '🔴' : iv.maybe.length ? '🟡' : '🟢'} `;
      add(groups.map(shortName).join(' · '), 'bold');
      const who = groups.flatMap((g) => (people[g] || []).map((p) => ({ ...p, hit: changed.has(g) })));
      if (who.length) {
        text += ' — ';
        who.forEach((p, i) => {
          if (i) text += ', ';
          if (p.hit && p.username) text += `@${p.username}`;
          else {
            if (p.hit) entities.push({ type: 'text_mention', offset: text.length, length: p.name.length, user: { id: Number(p.uid) } });
            text += p.name;
          }
        });
      }
      text += '\n';
      if (iv.off.length) text += `⛔ ${fmt(iv.off).replaceAll(', ', ' · ')}  (${hoursOff(iv.off)})`;
      else text += '✅ без відключень';
      if (iv.maybe.length) text += `\n❓ можливо ${fmt(iv.maybe).replaceAll(', ', ' · ')}`;
    }
    if (text.length > quoteFrom) entities.push({ type: 'blockquote', offset: quoteFrom, length: text.length - quoteFrom });
  }
  if (!sections.length) text += '\n\nДаних про графік поки немає.';
  entities.sort((x, y) => x.offset - y.offset || y.length - x.length);
  return { text, entities };
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

/** /графики — сводка по всем очередям прямо сейчас */
export async function outageAll(chatId, st, replyTo, fetchFn = fetch) {
  let data;
  try {
    data = await loadData(fetchFn);
  } catch (e) {
    console.warn('[outage]', e.message);
    return void (await say(chatId, st, 'Не дотягуюсь до графіків, спробуй трохи пізніше.', replyTo));
  }
  const m = buildSummary(data, peopleByGroup(sub(st)), { title: '💡 Світло по всіх чергах', subtitle: updated(data) ? `оновлено ${updated(data)}` : '' });
  await say(chatId, st, m.text, replyTo, { entities: m.entities });
}

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
  const msg = buildSummary(data, { [g]: [{ uid: from.id, name: from.first_name || from.username || 'друг', username: from.username }] }, {
    title: `💡 Черга ${shortName(g)}`,
    subtitle: mine === g || !parseGroup(text) ? '' : "Запам'ятав твою чергу: кидатиму вранці, ввечері і коли графік зміниться.",
    only: [g],
  });
  await reply(msg.text, { entities: msg.entities });
}

const isQuiet = (hour) => (config.quietFrom <= config.quietTo ? hour >= config.quietFrom && hour < config.quietTo : hour >= config.quietFrom || hour < config.quietTo);

export const ANNOUNCE = 'Кто хочет получать уведомления о графике света с отметкой, напишите «моя очередь 3.1» (свой номер, например 6.2) или команду /свет 3.1. Я запомню и отмечу вас сразу, как только выйдет новый график. /график покажет все очереди, /свет стоп отпишет.';

/**
 * Раз в минуту из планировщика: один раз зовём подписаться, дальше утренняя и вечерняя сводки по всем очередям
 * и сразу сообщение с отметками подписчиков, как только вышел новый график или он поменялся (ночью не будим).
 */
export async function outageTick(now = Date.now(), fetchFn = fetch) {
  if (botOff() || !app.telegram) return;
  const chats = allChats().filter(([id, st]) => id < 0 && st.outage && !(st.kickedAt && (st.history.at(-1)?.ts ?? 0) < st.kickedAt));
  if (!chats.length || now - lastPoll < POLL_MS) return;
  lastPoll = now;
  const data = await loadData(fetchFn, now);
  const all = listGroups(data);
  const hour = hourOf(now);
  const today = dayKey(now);
  const hasTomorrow = daysOf(data, now).some((d) => d.label === 'Завтра');
  for (const [chatId, st] of chats) {
    const o = sub(st);
    const people = peopleByGroup(o);
    const hashes = Object.fromEntries(all.map((g) => [g, groupHash(data, g)]));
    const baseline = () => Object.assign(o.hashes, hashes);
    const send = async (m) => say(chatId, st, m.text, undefined, { entities: m.entities });
    try {
      if (isQuiet(hour)) continue;
      if (!o.announced) {
        o.announced = true;
        save();
        await say(chatId, st, ANNOUNCE);
        continue;
      }
      if (!Object.keys(o.users).length) continue;
      const changed = new Set(all.filter((g) => o.hashes[g] !== undefined && o.hashes[g] !== hashes[g]));
      const newTomorrow = hasTomorrow && o.tomorrowSeen !== today;
      if (hasTomorrow) o.tomorrowSeen = today;
      if (hour >= config.outageHour && o.morningDay !== today) {
        o.morningDay = today;
        baseline();
        save();
        await send(buildSummary(data, people, { title: '☀️ Доброго ранку! Світло по всіх чергах', now }));
      } else if (changed.size) {
        // новый график (или правка): сразу в чат, с отметкой подписчиков изменившихся очередей
        baseline();
        if (hasTomorrow) o.eveningDay = today; // это сообщение уже содержит и завтра
        save();
        const title = newTomorrow ? '🆕 Вийшов новий графік' : `🔄 Графік змінився (черги: ${[...changed].map(shortName).join(', ')})`;
        await send(buildSummary(data, people, { title, changed, now }));
      } else if (hour >= config.outageEveningHour && o.eveningDay !== today && hasTomorrow) {
        o.eveningDay = today;
        save();
        await send(buildSummary(data, people, { title: '🌙 Добрий вечір! Світло на завтра по всіх чергах', days: ['Завтра'], now }));
      } else {
        baseline();
        save();
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
