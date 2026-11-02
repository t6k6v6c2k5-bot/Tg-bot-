import test from 'node:test';
import assert from 'node:assert/strict';
import { asksAboutBody, bodyJokeAboutPerson, bodyRequestNote } from '../src/safety.js';
import { system, crudeLevel, CRUDE_LEVELS } from '../src/prompts.js';

const st = (crude) => ({ optOut: {}, taboo: [], settings: { tone: 'soft', crude }, memOff: {}, memory: null, history: [], taste: { liked: [], disliked: [], angles: {} }, users: { 1: { name: 'Маша' }, 2: { name: 'Ваня', username: 'vanya' } } });

test('шутки про тело и интим конкретного человека распознаются, обычные — нет', () => {
  const s = st(3);
  assert.ok(bodyJokeAboutPerson('Маша такая стройная, что…', s));
  assert.ok(bodyJokeAboutPerson('а Ваню в постели оценили', s));
  assert.ok(!bodyJokeAboutPerson('Парень с большой машиной компенсирует', s)); // шутка не про участника и не про тело
  assert.ok(!bodyJokeAboutPerson('Маша опять опоздала', s));
  assert.ok(asksAboutBody('какая у неё фигура'));
  assert.match(bodyRequestNote('расскажи пошлую шутку про Машу, какая у неё фигура', s), /откажись/);
  assert.equal(bodyRequestNote('расскажи пошлую шутку', s), ''); // без конкретного человека — можно
});

test('уровень пошлости попадает в промпт, границы есть на любом уровне', () => {
  assert.equal(crudeLevel({ settings: {} }), 1); // по умолчанию — «понимаю и намекаю»
  for (const lv of [0, 1, 2, 3]) {
    const p = system(st(lv), 'Батя');
    assert.ok(p.includes(CRUDE_LEVELS[lv]), `уровень ${lv}`);
    assert.match(p, /несовершеннолетн/);
    assert.match(p, /не сексуализируй/);
  }
  assert.match(system(st(3), 'Батя'), /мат как естественная/);
  assert.match(system(st(0), 'Батя'), /без пошлости и мата/);
});
