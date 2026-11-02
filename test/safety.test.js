import test from 'node:test';
import assert from 'node:assert/strict';
import { asksAboutBody, bodyJokeAboutPerson, bodyRequestNote } from '../src/safety.js';
import { system, crudeLevel, CRUDE_LEVELS } from '../src/prompts.js';

const st = (crude) => ({ optOut: {}, taboo: [], settings: { tone: 'soft', crude }, memOff: {}, memory: null, history: [], taste: { liked: [], disliked: [], angles: {} }, users: { 1: { name: 'Маша' }, 2: { name: 'Ваня', username: 'vanya' } } });

test('блокируется только сексуализация конкретных участников; стёб про внешность и привычки — можно', () => {
  const s = st(3);
  assert.ok(bodyJokeAboutPerson('а Ваню в постели оценили', s));
  assert.ok(bodyJokeAboutPerson('Маша голая на фото', s));
  assert.ok(!bodyJokeAboutPerson('Маша такая стройная, что…', s)); // внешность — дружеский стёб, разрешено
  assert.ok(!bodyJokeAboutPerson('Ваня опять толстый кот в хлам', s));
  assert.ok(!bodyJokeAboutPerson('Парень с большой машиной компенсирует', s)); // не про участника
  assert.ok(!bodyJokeAboutPerson('Маша опять опоздала', s));
  assert.ok(asksAboutBody('какой у неё секс-символ'));
  assert.match(bodyRequestNote('расскажи секс шутку про Машу', s), /откажись/);
  assert.equal(bodyRequestNote('расскажи пошлую шутку про секс', s), ''); // без конкретного человека — можно
});

test('уровень пошлости попадает в промпт, границы есть на любом уровне', () => {
  assert.equal(crudeLevel({ settings: {} }), 3); // по умолчанию — без ограничений по уровню шуток
  for (const lv of [0, 1, 2, 3]) {
    const p = system(st(lv), 'Батя');
    assert.ok(p.includes(CRUDE_LEVELS[lv]), `уровень ${lv}`);
    assert.match(p, /несовершеннолетн/);
    assert.match(p, /не сексуализируй/);
  }
  assert.match(system(st(3), 'Батя'), /мат как естественная/);
  assert.match(system(st(0), 'Батя'), /без пошлости и мата/);
});

test('несдвигаемые линии остаются в промпте на любом уровне и тоне', () => {
  for (const tone of ['free', 'hard', 'soft']) {
    const p = system({ ...st(3), settings: { tone, crude: 3 } }, 'Батя');
    assert.match(p, /НЕСДВИГАЕМЫЕ ЛИНИИ/);
    assert.match(p, /несовершеннолетн/);
    assert.match(p, /угроз/);
    assert.match(p, /личные данные/);
    assert.match(p, /не унижай группы людей/);
  }
  assert.match(system({ ...st(3), settings: { tone: 'free', crude: 3 } }, 'Батя'), /Тон выбираешь сам/);
});
