import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK, chatPrompt, system } from '../src/prompts.js';

test('режим критики: признать промах и поправиться, а не огрызаться', () => {
  assert.match(TASK.critic, /покритиковали/);
  assert.match(TASK.critic, /признай/i);
  assert.match(TASK.critic, /поправься/);
  const st = { optOut: {}, taboo: [], settings: { tone: 'free', crude: 3 }, memory: null, history: [{ uid: 1, name: 'Руслан', text: 'Набор слов', ts: 1 }], taste: { liked: [], disliked: [], angles: {} }, users: {} };
  assert.match(chatPrompt(st.history, 'critic'), /Задача: Твою реплику только что покритиковали/);
  assert.match(system(st, 'Батя'), /Смысл важнее эффекта/);
  assert.match(TASK.direct, /именно на то, что сказал человек/);
});
