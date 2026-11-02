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
  assert.equal(parseReply('а\nб\nв\nг\nд').text, 'а\nб\nв\nг'); // длину выбирает бот: до 4 строк
  assert.ok(parseReply('я'.repeat(1000)).text.length <= 500);
});

test('политика и война больше не блокируют самостоятельные реплики, горе — по-прежнему', () => {
  const pol = mk({ history: [{ text: 'а я считаю, что Крым наш', name: 'a' }] });
  assert.ok(canSpeakUnsolicited(pol, NOW)); // бот сам решает, вступать ли
  assert.equal(decide({ direct: true, text: 'батя, чей Крым?', st: pol, now: NOW }), 'direct');
  const grief = mk({ history: [{ text: 'у меня вчера умерла бабушка', name: 'a' }] });
  assert.ok(!canSpeakUnsolicited(grief, NOW)); // не стёбся над бедой: это остаётся
});

test('протечка рассуждений и префикс «Батя:» отсекаются', () => {
  assert.deepEqual(parseReply('This is a standard query.\nDraft: «Меня создал @vladik4638»'), { type: 'skip' });
  assert.deepEqual(parseReply('Answer: ok'), { type: 'skip' });
  assert.equal(parseReply('Батя: Ну здорово, орлы').text, 'Ну здорово, орлы');
  assert.equal(parseReply('Ну здорово, Dota-фанаты').text, 'Ну здорово, Dota-фанаты'); // отдельные латинские слова не мешают
});

test('кавычки: обрамляющие срезаются, а цитата в начале реплики остаётся целой', () => {
  assert.equal(parseReply('«Ну ты и скажешь»').text, 'Ну ты и скажешь');
  assert.equal(parseReply('"Ну ты и скажешь"').text, 'Ну ты и скажешь');
  // цитата в начале, но реплика на этом не заканчивается: кавычки не трогаем
  assert.equal(parseReply('«машину отмывала полдня» — признайся, тебе заняться нечем?').text, '«машину отмывала полдня» — признайся, тебе заняться нечем?');
  assert.equal(parseReply('Он сказал «хватит» и ушёл').text, 'Он сказал «хватит» и ушёл');
});
