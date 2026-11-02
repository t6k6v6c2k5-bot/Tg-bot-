import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-REGRESS';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
process.env.GEMINI_MODEL = 'regress-model';
process.env.GEMINI_SMART_MODEL = 'regress-model';
process.env.AI_RPM = '200';
const { chatPrompt, system } = await import('../src/prompts.js');
const { closerKind, isAbuse } = await import('../src/filter.js');
const { app, respond } = await import('../src/respond.js');
const { refreshRoster } = await import('../src/roster.js');
const { emptyMemory } = await import('../src/memory.js');

test('ДАННЫЕ ЧАТА реально попадают в промпт (раньше четвёртый параметр молча игнорировался)', () => {
  const history = [{ uid: 1, name: 'Руслан', text: 'батя, что за Ваня?', ts: Date.now() }];
  const p = chatPrompt(history, 'direct', 30, 'Ваня: писал(а) 2 ч назад, сообщений за неделю: 14');
  assert.match(p, /ДАННЫЕ ЧАТА \(посчитано программой, точно\)/);
  assert.match(p, /сообщений за неделю: 14/);
  assert.doesNotMatch(chatPrompt(history, 'direct', 30), /ДАННЫЕ ЧАТА/); // без данных блока нет
});

test('промпт говорит, кто написал последнее сообщение, чтобы не путать имена', () => {
  const p = chatPrompt([{ uid: 1, name: 'Руслан', text: 'привет', ts: Date.now() }], 'direct');
  assert.match(p, /Последнее сообщение написал\(а\): «Руслан»/);
  assert.match(p, /чужие имена из списка участников для адресата не бери/);
  assert.doesNotMatch(chatPrompt([{ uid: 0, name: 'Батя', text: 'я', ts: 1, bot: true }], 'direct'), /Последнее сообщение написал/);
});

test('ориентацию, здоровье и личную жизнь бот не обсуждает', () => {
  const st = { optOut: {}, taboo: [], settings: { tone: 'free', crude: 3 }, memory: null, history: [], taste: { liked: [], disliked: [], angles: {} }, users: {} };
  assert.match(system(st, 'Батя'), /не гадай и не обсуждай, какой у кого сексуальной ориентации/i);
});

test('похвала в адрес бота — тоже точка, а вопрос — нет', () => {
  for (const t of ['Да ты харош', 'ты харош', 'красава', 'молодец', 'жиза', 'ржака', 'Огонь!', 'ну ты даёшь']) assert.equal(closerKind(t), 'praise', t);
  for (const t of ['ты харош?', 'а почему ты харош', 'харош, а теперь расскажи про Крым']) assert.equal(closerKind(t), null, t);
});

test('брань в адрес бота распознаётся', () => {
  for (const t of ['иди нахуй', 'Нахуй ты нада?', 'ты робот сука ебучий', 'педрила', 'заткнись', 'ты дебил']) assert.ok(isAbuse(t), t);
  for (const t of ['что на ужин', 'ты крутой', 'расскажи про суп', 'хуйня какая-то про бота'.replace('хуйня какая-то', 'странно')]) assert.ok(!isAbuse(t), t);
});

// клиент Telegram для тестов ответов (объявлен до тестов, чтобы их порядок не влиял)
const sentEarly = [];
app.telegram = { sendMessage: async (c, t) => (sentEarly.push(t), { message_id: 1 }), setMessageReaction: async () => {} };
app.id = 99;
app.name = 'Батя';

test('число участников берётся через callApi (метод getChatMemberCount в Telegraf называется иначе)', async () => {
  const calls = [];
  const saved = app.telegram; // тест подменяет клиент Telegram — вернём на место, иначе сломаются следующие тесты
  app.telegram = {
    getChatAdministrators: async () => [{ user: { id: 1, first_name: 'Админ' } }],
    callApi: async (method, p) => (calls.push([method, p]), 304),
  };
  const st = { users: {}, history: [] };
  try {
    await refreshRoster(-1, st);
  } finally {
    app.telegram = saved;
  }
  assert.equal(st.memberCount, 304);
  assert.deepEqual(calls, [['getChatMemberCount', { chat_id: -1 }]]);
  assert.equal(st.users[1].isAdmin, true);
});

const sent = [];
app.telegram = { sendMessage: async (c, t) => (sent.push(t), { message_id: 100 + sent.length }), setMessageReaction: async () => {} };
app.id = 99;
app.name = 'Батя';
const mkst = (q, over = {}) => ({ optOut: {}, taboo: [], settings: { v: 2, tone: 'free', crude: 3, activity: 3, mutedUntil: 0 }, memOff: {}, memory: emptyMemory(), taste: { liked: [], disliked: [], angles: {} }, unsol: [], roastLast: {}, users: { 1: { name: 'Руслан' } }, history: [{ id: 1, uid: 1, name: 'Руслан', text: q, ts: Date.now() }], ...over });
const reply = (t) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] }));
const lastUserText = (opts) => JSON.parse(opts.body).contents[0].parts.at(-1).text;

test('прямые обращения встают в очередь, а не теряются, пока чат занят', async () => {
  sent.length = 0;
  let inflight = 0;
  let maxInflight = 0;
  globalThis.fetch = async () => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 120));
    inflight--;
    return reply('1) ответ\nЛУЧШИЙ: 1');
  };
  const st1 = mkst('первый вопрос');
  const st2 = mkst('второй вопрос');
  const [a, b] = await Promise.all([respond(-7, st1, { mode: 'direct', replyTo: 1 }), respond(-7, st2, { mode: 'direct', replyTo: 1 })]);
  assert.ok(a && b, 'оба прямых обращения должны получить ответ');
  assert.equal(sent.length, 2);
  assert.equal(maxInflight, 1); // по одному на чат одновременно
});

test('самовольная реплика при занятом чате отбрасывается, а не копится', async () => {
  sent.length = 0;
  globalThis.fetch = async () => (await new Promise((r) => setTimeout(r, 100)), reply('1) ответ\nЛУЧШИЙ: 1'));
  const [a, b] = await Promise.all([respond(-8, mkst('вопрос'), { mode: 'direct', replyTo: 1 }), respond(-8, mkst('болтовня'), { mode: 'random', replyTo: 1 })]);
  assert.ok(a);
  assert.equal(b, false);
});

test('тролль ругается, а ответ слабый — бот молчит; нормальный вопрос получает ответ даже при слабом', async () => {
  sent.length = 0;
  globalThis.fetch = async () => reply('1) слабая шутка\nЛУЧШИЙ: 0');
  await respond(-9, mkst('ты робот сука ебучий'), { mode: 'direct', replyTo: 1 });
  assert.equal(sent.length, 0); // промолчал
  sent.length = 0;
  await respond(-10, mkst('батя, что на ужин?'), { mode: 'direct', replyTo: 1 });
  assert.equal(sent.length, 1); // человек спросил по-человечески — отвечаем в любом случае
});

test('в аналитическом вопросе модель получает блок данных', async () => {
  sent.length = 0;
  const seen = [];
  globalThis.fetch = async (url, opts) => (seen.push(lastUserText(opts)), reply('Ваня писал недавно.'));
  const st = mkst('батя, что за Ваня?', { users: { 1: { name: 'Руслан' }, 2: { name: 'Ваня', username: 'vanya', msgs: 7, lastSeen: Date.now() - 3600_000, firstSeen: Date.now() - 86400_000 } } });
  await respond(-11, st, { mode: 'direct', replyTo: 1 });
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((t) => /ДАННЫЕ ЧАТА/.test(t) && /Ваня/.test(t)), 'каждый запрос к модели содержит досье');
});
