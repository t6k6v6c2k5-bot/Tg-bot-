import test from 'node:test';
import assert from 'node:assert/strict';
import { pickInitiative, isQuietHour, pickPokeTarget, trackIgnore, onHumanMessage } from '../src/life.js';
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
  assert.equal(pickInitiative(mk({ initLog: [NOW - 3 * H, NOW - 4 * H, NOW - 5 * H, NOW - 6 * H] }), NOW, opt), null); // cap=4
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
  const long = 'a\nb\nc\nd\ne\nf\ng';
  assert.equal(parseReply(long).text.split('\n').length, 2);
  assert.equal(parseReply(long, { maxLines: 5, maxChars: 700 }).text.split('\n').length, 5);
});
