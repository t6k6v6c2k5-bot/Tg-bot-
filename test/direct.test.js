import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-DIRECT';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
process.env.GEMINI_MODEL = 'direct-model';
process.env.GEMINI_SMART_MODEL = 'direct-model';
process.env.AI_RPM = '100';
const { app, respond } = await import('../src/respond.js');
const { emptyMemory } = await import('../src/memory.js');
const { parseReply } = await import('../src/parse.js');

const sent = [];
app.telegram = { sendMessage: async (c, t) => (sent.push(t), { message_id: 100 + sent.length }), setMessageReaction: async () => {} };
app.id = 99;
app.name = 'Батя';
const mkst = (q) => ({ optOut: {}, taboo: [], settings: { v: 2, tone: 'free', crude: 3, activity: 3, mutedUntil: 0 }, memOff: {}, memory: emptyMemory(), taste: { liked: [], disliked: [], angles: {} }, unsol: [], roastLast: {}, users: { 1: { name: 'Руслан' } }, history: [{ id: 1, uid: 1, name: 'Руслан', text: q, ts: Date.now() }] });
const reply = (t) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] }));
const promptOf = (opts) => JSON.parse(opts.body).contents[0].parts.at(-1).text;
const reset = () => (sent.length = 0);

test('REFUSE разбирается', () => {
  assert.deepEqual(parseReply('REFUSE: Это не ко мне.'), { type: 'refuse', text: 'Это не ко мне.' });
  assert.equal(parseReply('refuse').type, 'refuse');
});

test('безобидная просьба при SKIP модели: бот пробует попроще и отвечает, а не «про такое не шучу»', async () => {
  reset();
  globalThis.fetch = async (url, opts) => (/без отказа и без SKIP/.test(promptOf(opts)) ? reply('Ладно: почему программисты путают Хэллоуин и Рождество? Oct 31 == Dec 25.') : reply('SKIP'));
  await respond(1, mkst('Расскажи ещё что-то'), { mode: 'direct', replyTo: 1 });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /программисты/);
  assert.doesNotMatch(sent[0], /Про такое не шучу|пас/);
});

test('если и попроще ничего: честное «мысль не идёт», без ложного отказа', async () => {
  reset();
  globalThis.fetch = async () => reply('SKIP');
  await respond(1, mkst('Расскажи ещё что-то'), { mode: 'direct', replyTo: 1 });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /мысль не идёт|пустая|Не придумал/);
  assert.doesNotMatch(sent[0], /не шучу/);
});

test('настоящий отказ по несдвигаемым линиям: бот говорит свою фразу', async () => {
  reset();
  globalThis.fetch = async () => reply('REFUSE: Такое не расскажу, тема закрыта.');
  await respond(1, mkst('расскажи пошлую шутку про школьницу'), { mode: 'direct', replyTo: 1 });
  assert.deepEqual(sent, ['Такое не расскажу, тема закрыта.']);
});

test('режим критики: один простой ответ, без «4 вариантов шуток»', async () => {
  reset();
  const prompts = [];
  globalThis.fetch = async (url, opts) => (prompts.push(promptOf(opts)), reply('Согласен, перемудрил. Если просто: лодка течёт — вычерпывай воду.'));
  await respond(1, mkst('Набор слов'), { mode: 'critic', replyTo: 1 });
  assert.equal(sent.length, 1);
  assert.ok(prompts.every((p) => !/ровно 4 РАЗНЫХ/.test(p)));
  assert.match(sent[0], /перемудрил/);
});
