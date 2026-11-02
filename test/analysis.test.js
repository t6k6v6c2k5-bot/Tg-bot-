import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTargets, isAnalytic, chatStats, dossier, rosterLine, analysisContext, statsText, silent } from '../src/analysis.js';
import { emptyMemory, mergeMemory } from '../src/memory.js';

const H = 3600_000;
const NOW = 1_800_000_000_000;

function mk() {
  const history = [];
  const add = (uid, name, text, ago, replyTo) => history.push({ id: history.length, uid, name, text, ts: NOW - ago, replyTo });
  for (let i = 0; i < 10; i++) add(1, 'Ваня', `го в доту ${i}`, (10 - i) * H);
  for (let i = 0; i < 4; i++) add(2, 'Маша', `не, у меня йога ${i}`, (9 - i) * H, 1);
  add(3, 'Дима', 'старое сообщение', 5 * 24 * H);
  history.sort((a, b) => a.ts - b.ts);
  const st = {
    history, memOff: {}, memory: emptyMemory(), memberCount: 6,
    users: {
      1: { name: 'Ваня', username: 'vanya', msgs: 10, firstSeen: NOW - 20 * 24 * H, lastSeen: NOW - H },
      2: { name: 'Маша', msgs: 4, firstSeen: NOW - 10 * 24 * H, lastSeen: NOW - 6 * H },
      3: { name: 'Дима', msgs: 1, firstSeen: NOW - 8 * 24 * H, lastSeen: NOW - 5 * 24 * H },
      4: { name: 'Оля', msgs: 0, isAdmin: true }, // админ, ещё не писала
      5: { name: 'Ушедший', msgs: 2, left: true },
    },
  };
  mergeMemory(st, { users: { Ваня: ['играет в доту'] } }, new Map([['Ваня', '1']]));
  return st;
}

test('видит всех известных, включая молчунов-админов, но не ушедших', () => {
  const line = rosterLine(mk());
  assert.match(line, /Ваня \(@vanya\)/);
  assert.match(line, /Оля/);
  assert.doesNotMatch(line, /Ушедший/);
  assert.match(line, /остальных ты по именам не знаешь/); // в чате 5 человек (кроме бота), знаем 4
});

test('находит людей в вопросе в любом падеже и по нику', () => {
  const st = mk();
  assert.deepEqual(detectTargets(st, 'батя, что за Ваня?'), ['1']);
  assert.deepEqual(detectTargets(st, 'расскажи про Ваню'), ['1']);
  assert.deepEqual(detectTargets(st, 'почему Маша молчит'), ['2']);
  assert.deepEqual(detectTargets(st, 'что думаешь про Диму?'), ['3']);
  assert.deepEqual(detectTargets(st, 'привет @vanya'), ['1']);
  assert.deepEqual(detectTargets(st, 'просто болтаем'), []);
});

test('аналитические вопросы распознаются', () => {
  assert.ok(isAnalytic('кто самый активный?'));
  assert.ok(isAnalytic('о чём вчера говорили'));
  assert.ok(!isAnalytic('привет, как дела'));
});

test('статистика считается кодом', () => {
  const st = mk();
  const day = chatStats(st, NOW, 24 * H);
  assert.equal(day.total, 14);
  assert.equal(day.ranked[0].name, 'Ваня');
  assert.equal(day.ranked[0].n, 10);
  assert.deepEqual(silent(st, NOW).sort(), ['Дима', 'Оля']);
  assert.match(statsText(st, NOW), /Ваня — 10/);
});

test('досье содержит факты и связи, а /забудь его скрывает', () => {
  const st = mk();
  assert.match(dossier(st, '1', NOW), /играет в доту/);
  assert.match(dossier(st, '2', NOW), /Чаще всего отвечает: Ваня/);
  st.memOff['1'] = true;
  const d = dossier(st, '1', NOW);
  assert.doesNotMatch(d, /доту/);
  assert.match(d, /не запоминать/);
});

test('контекст: для болтовни пусто, для вопроса про человека и статистики есть данные', () => {
  const st = mk();
  assert.equal(analysisContext(st, 'ахах точно', NOW), '');
  assert.match(analysisContext(st, 'батя, что за Ваня?', NOW), /играет в доту/);
  const c = analysisContext(st, 'кто самый активный?', NOW);
  assert.match(c, /Ваня — 10/);
});
