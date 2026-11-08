import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-'));
process.env.ADMIN_IDS = '777';

const { botMode, setBotMode, parseMode, NEXT } = await import('../src/botmode.js');
const { chat } = await import('../src/store.js');
const { handleCommand, parseCommand } = await import('../src/commands.js');
const { app } = await import('../src/respond.js');
const { processMessage } = await import('../src/pipeline.js');
const { cardKeyboard, chatInfo } = await import('../src/admin.js');

test('режим по умолчанию смешанный, цикл переключения и разбор слов', () => {
  const st = chat(-300);
  assert.equal(botMode(st), 'mixed');
  assert.equal(NEXT.mixed, 'nolight');
  assert.equal(NEXT.nolight, 'light');
  assert.equal(parseMode('свет'), 'light');
  assert.equal(parseMode('только свет'), 'light');
  assert.equal(parseMode('смешанный'), 'mixed');
  assert.equal(parseMode('без света'), 'nolight');
  assert.equal(parseMode('абракадабра'), null);
  setBotMode(st, 'light');
  assert.equal(botMode(st), 'light');
  setBotMode(st, 'ерунда');
  assert.equal(botMode(st), 'mixed');
});

test('кнопка режима в карточке чата', () => {
  const st = chat(-301);
  const kb = JSON.stringify(cardKeyboard(chatInfo(-301, st)));
  assert.match(kb, /Режим: 🎭 смешанный/);
  assert.match(kb, /a:bm:-301/);
});

const setup = () => {
  const sent = [];
  app.telegram = { sendMessage: async (id, t) => (sent.push(t), { message_id: sent.length }), setMessageReaction: async () => {} };
  app.username = 'batya_bot';
  app.id = 1;
  return sent;
};
const ctxFor = (id, from) => ({ chat: { id, type: 'supergroup' }, from });
const msg = (text, from) => ({ message_id: 1, from, text, entities: [] });
const run = async (st, text, from = { id: 5, first_name: 'Влад' }) => {
  st.history.push({ id: 1, uid: from.id, name: from.first_name, text, ts: Date.now() });
  await processMessage(ctxFor(-302, from), st, msg(text, from), { text });
};

test('режим «только свет»: на болтовню молчит, команды кроме света игнорирует', async () => {
  const sent = setup();
  const st = chat(-302);
  setBotMode(st, 'light');
  await run(st, 'Батя, расскажи анекдот');
  assert.equal(sent.length, 0);
  // чужая команда не обрабатывается, но и ответа нет
  const r = await handleCommand(ctxFor(-302, { id: 5 }), parseCommand('/прожарь @x'), msg('/прожарь @x', { id: 5 }));
  assert.equal(r, true);
  assert.equal(sent.length, 0);
});

test('режим «без света»: команды света молчат', async () => {
  const sent = setup();
  const st = chat(-303);
  setBotMode(st, 'nolight');
  const r = await handleCommand(ctxFor(-303, { id: 5 }), parseCommand('/график'), msg('/график', { id: 5 }));
  assert.equal(r, true);
  assert.equal(sent.length, 0);
});

test('/режим меняет только админ бота', async () => {
  const sent = setup();
  const st = chat(-304);
  await handleCommand(ctxFor(-304, { id: 5 }), parseCommand('/режим свет'), { ...msg('/режим свет', { id: 5 }), message_id: 9 });
  assert.equal(botMode(st), 'mixed'); // чужой не может
  assert.match(sent.at(-1), /только админ/);
  await handleCommand(ctxFor(-304, { id: 777 }), parseCommand('/режим свет'), { ...msg('/режим свет', { id: 777 }), message_id: 9 });
  assert.equal(botMode(st), 'light');
  assert.match(sent.at(-1), /только свет/);
});
