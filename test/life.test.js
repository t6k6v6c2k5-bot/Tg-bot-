import test from 'node:test';
import assert from 'node:assert/strict';
import { pickInitiative, isQuietHour, pickPokeTarget, trackIgnore, onHumanMessage, dailyCap, recordOutcome, silenceThreshold, isAwake, wakeHourFor, noteHour } from '../src/life.js';
import { parseReply } from '../src/parse.js';

const H = 3600_000;
const NOW = 1_800_000_000_000;

function mk(over = {}) {
  const history = [];
  for (let i = 0; i < 20; i++) history.push({ uid: 1 + (i % 2), name: i % 2 ? 'Маша' : 'Ваня', text: 'болтаем про кино', ts: NOW - 6 * H - i * 60_000 });
  return {
    history,
    users: { 1: { name: 'Ваня', username: 'vanya' }, 2: { name: 'Маша' } },
    memory: { users: {}, memes: [], style: '' }, memOff: {},
    settings: { activity: 3, tone: 'soft', mutedUntil: 0, autonomy: true },
    initLog: [], lastInitAt: 0, initTryAt: 0, ignored: 0, lastReviveAt: 0, lastTaleAt: 0, lastGreetDay: 'x', pokeLast: {},
    ...over,
  };
}
const opt = { hour: 15, today: '2026-11-02', rng: () => 0.01 };

test('ночью молчит', () => {
  assert.ok(isQuietHour(3) && !isQuietHour(9) && !isQuietHour(23));
  assert.equal(pickInitiative(mk(), NOW, { ...opt, hour: 3 }), null);
});

test('днём после долгой тишины заговаривает', () => {
  assert.ok(['revive', 'poke', 'tale'].includes(pickInitiative(mk(), NOW, opt)));
});

test('пока болтают — молчит', () => {
  const st = mk();
  st.history.push({ uid: 1, name: 'Ваня', text: 'привет', ts: NOW - 5 * 60_000 });
  assert.equal(pickInitiative(st, NOW, opt), null);
});

test('режим тишины, выключенная «жизнь», активность 1', () => {
  assert.equal(pickInitiative(mk({ settings: { activity: 3, mutedUntil: NOW + 1, autonomy: true } }), NOW, opt), null);
  assert.equal(pickInitiative(mk({ settings: { activity: 3, mutedUntil: 0, autonomy: false } }), NOW, opt), null);
  assert.equal(pickInitiative(mk({ settings: { activity: 1, mutedUntil: 0, autonomy: true } }), NOW, opt), null);
});

test('суточный лимит и пауза между инициативами', () => {
  const cap = dailyCap(mk());
  const log = Array.from({ length: cap }, (_, i) => NOW - (i + 1) * H);
  assert.equal(pickInitiative(mk({ initLog: log }), NOW, opt), null);
  assert.equal(pickInitiative(mk({ lastInitAt: NOW - 20 * 60_000 }), NOW, opt), null);
});

test('после двух проигнорированных замолкает, человек будит', () => {
  const st = mk({ ignored: 2 });
  assert.equal(pickInitiative(st, NOW, opt), null);
  onHumanMessage(st);
  assert.ok(pickInitiative(st, NOW, opt));
});

test('игнор считается через 2 часа без реакции', () => {
  const st = mk({ initOpen: true, lastInitAt: NOW - 3 * H });
  trackIgnore(st, NOW);
  assert.equal(st.ignored, 1);
  assert.equal(st.initOpen, false);
  assert.ok(st.engage < 0.5); // игнор снижает отзывчивость
});

test('утреннее приветствие раз в день', () => {
  const st = mk({ lastGreetDay: '2026-11-01' });
  st.history.forEach((m) => (m.ts += 5 * H)); // чат писал недавно
  assert.equal(pickInitiative(st, NOW, { hour: 9, today: '2026-11-02', rng: () => 0.01 }), 'greeting');
  st.lastGreetDay = '2026-11-02';
  assert.notEqual(pickInitiative(st, NOW, { hour: 9, today: '2026-11-02', rng: () => 0.01 }), 'greeting');
});

test('серьёзная тема и мёртвый чат — не лезет', () => {
  const sad = mk();
  sad.history.push({ uid: 1, name: 'Ваня', text: 'у меня умер дед', ts: NOW - 6 * H });
  assert.equal(pickInitiative(sad, NOW, opt), null);
  const dead = mk();
  dead.history.forEach((m) => (m.ts -= 5 * 24 * H));
  assert.equal(pickInitiative(dead, NOW, opt), null);
});

test('кого звать: давно молчащих, не чаще раза в сутки', () => {
  const st = mk();
  assert.ok(pickPokeTarget(st, NOW, () => 0));
  st.pokeLast = { 1: NOW - H, 2: NOW - H };
  assert.equal(pickPokeTarget(st, NOW, () => 0), null);
});

test('длинные ответы только по запросу', () => {
  const long = 'а\nб\nв\nг\nд\nе\nж';
  assert.equal(parseReply(long).text.split('\n').length, 4);
  assert.equal(parseReply(long, { maxLines: 6, maxChars: 700 }).text.split('\n').length, 6);
});

test('бюджет сам растёт от отклика чата и падает от игнора (уровень 5: 10 ↔ 4)', () => {
  const lively = mk({ settings: { activity: 5, tone: 'soft', mutedUntil: 0, autonomy: true } });
  for (let i = 0; i < 12; i++) recordOutcome(lively, 'revive', 1);
  assert.equal(dailyCap(lively), 10);
  const dead = mk({ settings: { activity: 5, tone: 'soft', mutedUntil: 0, autonomy: true } });
  for (let i = 0; i < 12; i++) recordOutcome(dead, 'revive', 0);
  assert.equal(dailyCap(dead), 4);
  assert.ok(dailyCap(mk()) > 4 && dailyCap(mk()) < 10 || dailyCap(mk()) === 5); // по умолчанию — середина
});

test('отклик на инициативу засчитывается: быстрый ответ Бате лучше позднего', () => {
  const a = mk({ initOpen: true, lastInitAt: NOW - 5 * 60_000, initKind: 'poke' });
  onHumanMessage(a, NOW, true);
  const b = mk({ initOpen: true, lastInitAt: NOW - 90 * 60_000, initKind: 'poke' });
  onHumanMessage(b, NOW, false);
  assert.ok(a.kindStats.poke.ema > b.kindStats.poke.ema);
  assert.equal(a.initOpen, false);
});

test('порог тишины учится на ритме чата', () => {
  const fast = mk();
  fast.history = Array.from({ length: 60 }, (_, i) => ({ uid: 1, name: 'a', text: 'x', ts: NOW - (60 - i) * 60_000 })); // сообщение в минуту
  const slow = mk();
  slow.history = Array.from({ length: 60 }, (_, i) => ({ uid: 1, name: 'a', text: 'x', ts: NOW - (60 - i) * 30 * 60_000 })); // раз в полчаса
  assert.ok(silenceThreshold(fast) < silenceThreshold(slow));
  assert.ok(silenceThreshold(fast) >= 30 * 60_000);
});

test('часы активности чата выучиваются, приветствие — когда там просыпаются', () => {
  const st = mk();
  assert.equal(isAwake(st, 3), false); // по умолчанию ночь
  for (let i = 0; i < 400; i++) { noteHour(st, 11 + (i % 10)); } // чат живёт с 11 до 20
  noteHour(st, 3); // единичное ночное сообщение не делает ночь «активной»
  assert.equal(isAwake(st, 3), false);
  assert.equal(isAwake(st, 15), true);
  assert.equal(isAwake(st, 9), false); // здесь утром никто не пишет, значит и Батя не лезет
  assert.equal(wakeHourFor(st), 11);
});
