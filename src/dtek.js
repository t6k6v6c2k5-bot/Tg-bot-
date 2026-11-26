import { config } from './config.js';

// Поиск очереди по адресу на официальном сайте ДТЕК Дніпровські електромережі (https://www.dtek-dnem.com.ua/ua/shutdowns).
// Протокол: GET страницы (csrf-токен, cookie, список улиц), затем POST /ua/ajax method=getHomeNum → по каждому дому его очередь (sub_type_reason: ['GPV3.1']).
// Сайт защищён WAF: если он не пускает бота, честно говорим об этом.

const BASE = 'https://www.dtek-dnem.com.ua';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let streetsCache = { at: 0, list: [] };

export class DtekBlocked extends Error {}

async function openSession(fetchFn) {
  const res = await fetchFn(`${BASE}/ua/shutdowns`, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': UA, 'accept-language': 'uk,en;q=0.9' } });
  if (!res.ok) throw new DtekBlocked(`HTTP ${res.status}`);
  const html = await res.text();
  const csrf = html.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
  if (!csrf) throw new DtekBlocked('нет csrf-токена (сайт отдал защитную страницу)');
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  // список улиц по городам лежит прямо в странице
  let streets = null;
  const i = html.indexOf('DisconSchedule.streets = ');
  if (i >= 0) {
    try {
      const src = html.slice(i + 'DisconSchedule.streets = '.length);
      const end = src.indexOf('};');
      streets = JSON.parse(src.slice(0, end + 1));
    } catch {
      streets = null;
    }
  }
  const updateFact = html.match(/"updateFact":"([^"]+)"/)?.[1] || '';
  return { csrf, cookie, streets, updateFact };
}

async function ajax(fetchFn, s, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetchFn(`${BASE}/ua/ajax`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      'user-agent': UA,
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: BASE,
      referer: `${BASE}/ua/shutdowns`,
      'x-requested-with': 'XMLHttpRequest',
      'x-csrf-token': s.csrf,
      ...(s.cookie ? { cookie: s.cookie } : {}),
    },
    body,
  });
  if (!res.ok) throw new DtekBlocked(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new DtekBlocked('ответ не JSON (защитная страница)');
  }
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[’`ʼ]/g, "'")
    .replace(/\b(?:вул|вулиця|просп|проспект|пров|провулок|бульв|бульвар|пл|площа|майдан|шосе|узвіз|ул|улица|переулок|тупик|туп|набережна|наб)\.?(?=\s|$)/gu, '')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** «Соборності 5», «вул. Володимира Великого 12А» → { street: 'Соборності', house: '5' } */
export function splitAddress(text) {
  const t = String(text || '').trim();
  const m = t.match(/^(.*\S)\s+(\d+(?:[\s/-]?[A-Za-zА-Яа-яІіЇїЄє])?(?:\/\d+)?)$/u);
  if (!m) return { street: t, house: '' };
  return { street: m[1].replace(/[,\s]+$/u, ''), house: m[2].replace(/\s+/g, '').toUpperCase() };
}

/** Улицы города, подходящие под запрос: точное совпадение имеет приоритет */
export function matchStreets(list, query) {
  const q = norm(query);
  if (!q) return [];
  const exact = list.filter((s) => norm(s) === q);
  if (exact.length) return exact;
  return list.filter((s) => norm(s).includes(q));
}

const sameHouse = (a, b) => String(a).replace(/\s+/g, '').toUpperCase().replace(/[A-Z]/g, (c) => ({ A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х' }[c] || c)) === String(b).replace(/\s+/g, '').toUpperCase().replace(/[A-Z]/g, (c) => ({ A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х' }[c] || c));

/**
 * @returns {{status:'ok', street:string, house:string, groups:string[]} | {status:'choose', streets:string[]} | {status:'nohouse', street:string, houses:string[]} | {status:'nostreet'}}
 */
export async function lookupGroup(text, fetchFn = fetch, now = Date.now()) {
  const { street, house } = splitAddress(text);
  const s = await openSession(fetchFn);
  const city = config.dtekCity;
  if (s.streets?.[city]) streetsCache = { at: now, list: s.streets[city] };
  const list = streetsCache.list;
  const found = matchStreets(list, street);
  if (!found.length) return { status: 'nostreet' };
  if (found.length > 1 || !house) return { status: 'choose', streets: found.slice(0, 8), needHouse: !house && found.length === 1 };
  const resp = await ajax(fetchFn, s, {
    method: 'getHomeNum',
    'data[0][name]': 'city',
    'data[0][value]': city,
    'data[1][name]': 'street',
    'data[1][value]': found[0],
    'data[2][name]': 'updateFact',
    'data[2][value]': s.updateFact,
  });
  const houses = resp?.data || {};
  const key = Object.keys(houses).find((h) => sameHouse(h, house));
  if (!key) return { status: 'nohouse', street: found[0], houses: Object.keys(houses).slice(0, 20) };
  const groups = (houses[key]?.sub_type_reason || []).filter((g) => /^GPV[\d.]+$/.test(g));
  return { status: 'ok', street: found[0], house: key, groups };
}
