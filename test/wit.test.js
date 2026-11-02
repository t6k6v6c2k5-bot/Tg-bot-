import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-WIT';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.WIT_JUDGE;
process.env.GEMINI_MODEL = 'wit-model';
const { bestOf, parseCandidates, parseBest } = await import('../src/wit.js');

const reply = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
const LIST = '1) Первый вариант про носки\n2) Второй вариант про котов\n3) Третий вариант про налоги\n4) Четвёртый вариант про лифты';
const run = (over = {}) => bestOf({ system: 's', prompt: 'p', context: 'ctx', direct: false, high: true, ...over });
let calls = 0;
const serve = (text) => {
  calls = 0;
  globalThis.fetch = async () => (calls++, reply(text));
};

test('разбор вариантов и пометки «ЛУЧШИЙ»', () => {
  assert.deepEqual(parseCandidates('1) один\n2. два\n- три\nЛУЧШИЙ: 2\nмусор'), ['один', 'два', 'три']);
  assert.equal(parseBest('1) a\nЛУЧШИЙ: 3'), 3);
  assert.equal(parseBest('лучший - 0'), 0);
  assert.equal(parseBest('нет пометки'), null);
});

test('одним запросом: модель сама называет лучший вариант', async () => {
  serve(LIST + '\nЛУЧШИЙ: 3');
  const r = await run();
  assert.equal(r.text, 'Третий вариант про налоги');
  assert.equal(r.pick, 3);
  assert.equal(calls, 1); // квоту не жжём: один запрос на реплику
});

test('все слабые: самовольная реплика — молчим, на прямое обращение отвечаем', async () => {
  serve(LIST + '\nЛУЧШИЙ: 0');
  const free = await run({ direct: false });
  assert.equal(free.text, 'SKIP');
  assert.equal(free.weak, true);
  const asked = await run({ direct: true });
  assert.equal(asked.text, 'Первый вариант про носки'); // человек спросил — лучшее из имеющегося
});

test('нет пометки «ЛУЧШИЙ» — берём первый годный', async () => {
  serve(LIST);
  assert.equal((await run()).text, 'Первый вариант про носки');
});

test('«ЛУЧШИЙ» указывает на исходный номер, даже если первые варианты отсеяны', async () => {
  serve(LIST + '\nЛУЧШИЙ: 4');
  const r = await run({ reject: (t) => /носки|котов/.test(t) });
  assert.equal(r.text, 'Четвёртый вариант про лифты');
  serve(LIST + '\nЛУЧШИЙ: 1'); // лучший отсеян — берём первый из оставшихся
  assert.equal((await run({ reject: (t) => /носки/.test(t) })).text, 'Второй вариант про котов');
});

test('всё отсеяно, SKIP от модели, ответ без списка', async () => {
  serve(LIST + '\nЛУЧШИЙ: 2');
  assert.equal((await run({ reject: () => true })).text, 'SKIP');
  serve('SKIP');
  assert.equal((await run()).text, 'SKIP');
  serve('Просто одна реплика без нумерации');
  assert.equal((await run()).text, 'Просто одна реплика без нумерации');
});
