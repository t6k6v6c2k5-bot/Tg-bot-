import { config } from './config.js';

// Графики отключений от Yasno (публичный API, без ключа): регион 3 «Дніпро», оператор 301 «ДнЕМ» = ДТЕК Дніпровські електромережі.
// Графики ДнЕМ одни на всю область (в том числе Кривой Рог): «усі міста та черги в регіоні відключають однаково».
// Приводим ответ к формату, который уже понимает модуль света: { fact: { update, data: { <unix начала дня>: { 'GPV3.1': { 1..24: 'yes'|'no'|'first'|'second' } } } } }.

const URL = () => `https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/${config.yasnoRegion}/dsos/${config.yasnoDso}/planned-outages`;

const fmtUpdated = (iso, tz) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
};

/** Слоты в минутах от полуночи → по часам: 'yes' | 'first' | 'second' | 'no' (полчаса считаем, если отключено >= 15 мин) */
export function slotsToHours(slots) {
  const off = (slots || []).filter((s) => s.type === 'Definite' || s.type === 'DEFINITE_OUTAGE');
  const cover = (a, b) => off.reduce((n, s) => n + Math.max(0, Math.min(b, s.end) - Math.max(a, s.start)), 0);
  const hours = {};
  for (let h = 1; h <= 24; h++) {
    const s = (h - 1) * 60;
    const first = cover(s, s + 30) >= 15;
    const second = cover(s + 30, s + 60) >= 15;
    hours[h] = first && second ? 'no' : first ? 'first' : second ? 'second' : 'yes';
  }
  return hours;
}

/** Ответ planned-outages → формат модуля света. День без действующего графика (ждём график, экстренные) пропускается. */
export function yasnoToData(json, tz = config.outageTz) {
  const days = {};
  let updatedOn = '';
  for (const [queue, v] of Object.entries(json || {})) {
    if (!/^\d{1,2}\.\d$/.test(queue) || !v || typeof v !== 'object') continue;
    if (v.updatedOn && v.updatedOn > updatedOn) updatedOn = v.updatedOn;
    for (const key of ['today', 'tomorrow']) {
      const day = v[key];
      if (!day || day.status !== 'ScheduleApplies' || !Array.isArray(day.slots)) continue;
      const ts = Math.floor(new Date(day.date).getTime() / 1000);
      if (!Number.isFinite(ts)) continue;
      (days[ts] ||= {})[`GPV${queue}`] = slotsToHours(day.slots);
    }
  }
  if (!Object.keys(days).length) throw new Error('Yasno: нет действующих графиков');
  return { source: 'yasno', fact: { update: fmtUpdated(updatedOn, tz), data: days } };
}

export async function fetchYasno(fetchFn = fetch) {
  const res = await fetchFn(URL(), { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; batya-bot)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} Yasno`);
  return yasnoToData(JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8')));
}
