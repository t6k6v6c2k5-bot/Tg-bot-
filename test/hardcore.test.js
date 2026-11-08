import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
process.env.ADMIN_IDS = '777';

const { hardcore, effActivity, setBotMode } = await import('../src/botmode.js');
const { chat } = await import('../src/store.js');
const { decide } = await import('../src/filter.js');
const { system, needlePrompt } = await import('../src/prompts.js');
const { dailyCap } = await import('../src/life.js');
const { handleCommand, parseCommand } = await import('../src/commands.js');
const { app } = await import('../src/respond.js');

test('хардкор: максимум активности, бот нападает первым, но в режиме «только свет» не действует', () => {
  const st = chat(-400);
  st.settings.activity = 1;
  const now = Date.now();
  assert.equal(decide({ direct: false, text: 'привет', st, now, rng: () => 0.1 }), null); // обычно на активности 1 молчит
  st.settings.hardcore = true;
  assert.equal(hardcore(st), true);
  assert.equal(effActivity(st), 5);
  assert.equal(decide({ direct: false, text: 'привет', st, now, rng: () => 0.1 }), 'random');
  assert.ok(dailyCap(st) >= 12);
  setBotMode(st, 'light');
  assert.equal(hardcore(st), false);
  setBotMode(st, 'mixed');
});

test('промпт хардкора агрессивный, но несдвигаемые линии остаются', () => {
  const st = chat(-401);
  assert.doesNotMatch(system(st, 'Батя'), /РЕЖИМ ХАРДКОР/);
  st.settings.hardcore = true;
  const p = system(st, 'Батя');
  assert.match(p, /РЕЖИМ ХАРДКОР/);
  assert.match(p, /никаких угроз физической расправы/);
  assert.match(needlePrompt({ name: 'Х', facts: [], lines: ['а'], history: [], hard: true }), /РЕЖИМ ХАРДКОР/);
});

test('/хардкор включает и выключает только админ бота', async () => {
  const sent = [];
  app.telegram = { sendMessage: async (id, t) => (sent.push(t), { message_id: sent.length }) };
  app.username = 'b';
  app.id = 1;
  const st = chat(-402);
  const run = (uid, text) => handleCommand({ chat: { id: -402, type: 'supergroup' }, from: { id: uid } }, parseCommand(text), { message_id: 1, from: { id: uid }, text });
  await run(5, '/хардкор вкл');
  assert.notEqual(st.settings.hardcore, true);
  await run(777, '/хардкор вкл');
  assert.equal(st.settings.hardcore, true);
  assert.match(sent.at(-1), /ХАРДКОР включён/);
  await run(777, '/хардкор выкл');
  assert.equal(st.settings.hardcore, false);
});
