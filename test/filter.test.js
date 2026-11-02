import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, isDirect, canSpeakUnsolicited, cheapReaction } from '../src/filter.js';
import { parseReply } from '../src/parse.js';

const mk = (over = {}) => ({
  history: [{ text: 'привет', name: 'a', ts: 0 }],
  settings: { activity: 3, tone: 'soft', mutedUntil: 0 },
  unsol: [], lastUnsolAt: 0, lastReactAt: 0, ...over,
});
const NOW = 1_000_000_000;

test('прямые обращения', () => {
  const o = { botUsername: 'my_bot', aliases: ['бот'], replyToBot: false };
  assert.ok(isDirect({ ...o, text: 'эй бот, привет' }));
  assert.ok(isDirect({ ...o, text: 'а что думает бота?' }));
  assert.ok(isDirect({ ...o, text: 'слышь @My_Bot' }));
  assert.ok(isDirect({ ...o, text: 'x', replyToBot: true }));
  assert.ok(!isDirect({ ...o, text: 'работа ботанов и ботинки' }));
});

test('режим тишины блокирует даже прямые обращения', () => {
  const st = mk({ settings: { activity: 5, tone: 'soft', mutedUntil: NOW + 1000 } });
  assert.equal(decide({ direct: true, text: 'бот', st, now: NOW }), null);
});

test('случайный шанс и лимит в час', () => {
  const st = mk();
  assert.equal(decide({ direct: false, text: 'обычное', st, now: NOW, rng: () => 0.01 }), 'random');
  assert.equal(decide({ direct: false, text: 'обычное', st, now: NOW, rng: () => 0.9 }), null);
  st.unsol = [NOW - 1000, NOW - 2000, NOW - 3000]; // cap=3
  assert.equal(decide({ direct: false, text: 'обычное', st, now: NOW, rng: () => 0 }), null);
});

test('триггер «скучно» повышает шанс', () => {
  assert.equal(decide({ direct: false, text: 'скучно(', st: mk(), now: NOW, rng: () => 0.3 }), 'trigger');
});

test('не говорит подряд и не лезет в серьёзное', () => {
  const botLast = mk({ history: [{ text: 'шутка', bot: true }] });
  assert.ok(!canSpeakUnsolicited(botLast, NOW));
  const sad = mk({ history: [{ text: 'у меня умерла бабушка', name: 'a' }] });
  assert.ok(!canSpeakUnsolicited(sad, NOW));
  assert.equal(decide({ direct: true, text: 'бот', st: sad, now: NOW }), 'direct');
});

test('минимальная пауза между самостоятельными репликами', () => {
  assert.ok(!canSpeakUnsolicited(mk({ lastUnsolAt: NOW - 60_000 }), NOW));
});

test('дешёвая реакция', () => {
  assert.equal(cheapReaction({ text: 'ахахах', st: mk(), now: NOW, rng: () => 0 }), '🤣');
  assert.equal(cheapReaction({ text: 'ахахах', st: mk({ lastReactAt: NOW - 1000 }), now: NOW, rng: () => 0 }), null);
});

test('разбор ответа ИИ', () => {
  assert.deepEqual(parseReply('SKIP'), { type: 'skip' });
  assert.deepEqual(parseReply(' skip.'), { type: 'skip' });
  assert.deepEqual(parseReply('REACT:🔥'), { type: 'react', emoji: '🔥' });
  assert.deepEqual(parseReply('REACT:💩'), { type: 'skip' });
  assert.equal(parseReply('"Ну ты и скажешь"').text, 'Ну ты и скажешь');
  assert.equal(parseReply('a\nb\nc').text, 'a\nb');
  assert.ok(parseReply('x'.repeat(1000)).text.length <= 280);
});
