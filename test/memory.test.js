import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanFact, mergeMemory, emptyMemory, memoryBlock, parseJson } from '../src/memory.js';

const mk = () => ({ memory: emptyMemory(), memOff: {}, users: { 1: { name: 'Ваня' }, 2: { name: 'Маша' } } });

test('чувствительные факты не записываются', () => {
  for (const bad of ['болеет гриппом', 'поссорился с девушкой', 'взял кредит', 'у него двое детей', 'живёт на Ленина 5', 'ходит в церковь', 'ему 30 лет', 'ва']) {
    assert.equal(cleanFact(bad), null, bad);
  }
  assert.equal(cleanFact('  - играет в Dota 2 '), 'играет в Dota 2');
  assert.equal(cleanFact('мужик на все руки'), 'мужик на все руки');
  assert.equal(cleanFact('мечтает о поездке в горы'), 'мечтает о поездке в горы');
});

test('слияние: дубли, лимит, memOff, неизвестные имена', () => {
  const st = mk();
  const names = new Map([['Ваня', '1'], ['Маша', '2']]);
  mergeMemory(st, { users: { Ваня: ['любит пельмени', 'любит пельмени', 'Играет в Dota 2'], Неизвестный: ['фанат джаза'] }, memes: ['кот-вагон'], style: 'коротко, с иронией' }, names, 1000);
  assert.deepEqual(st.memory.users['1'].map((f) => f.t), ['любит пельмени', 'Играет в Dota 2']);
  assert.equal(st.memory.memes.length, 1);
  assert.equal(st.memory.style, 'коротко, с иронией');
  st.memOff['2'] = true;
  mergeMemory(st, { users: { Маша: ['любит чай'] } }, names, 2000);
  assert.equal(st.memory.users['2'], undefined);
  for (let i = 0; i < 12; i++) mergeMemory(st, { users: { Ваня: [`уникальный факт номер ${i}x${i * 7}`] } }, names, 3000 + i);
  assert.ok(st.memory.users['1'].length <= 8);
});

test('блок памяти только про активных и без забытых', () => {
  const st = mk();
  mergeMemory(st, { users: { Ваня: ['любит пельмени'], Маша: ['коллекционирует кактусы'] } }, new Map([['Ваня', '1'], ['Маша', '2']]));
  const history = [{ uid: 1, name: 'Ваня', text: 'привет' }];
  const block = memoryBlock(st, history);
  assert.match(block, /Ваня: любит пельмени/);
  assert.doesNotMatch(block, /кактус/);
  st.memOff['1'] = true;
  assert.doesNotMatch(memoryBlock(st, history), /пельмени/);
});

test('разбор JSON из ответа ИИ', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseJson('нет json'), null);
});
