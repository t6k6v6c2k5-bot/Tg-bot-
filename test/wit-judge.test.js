import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-JUDGE';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
process.env.WIT_JUDGE = '1'; // режим отдельного редактора
process.env.GEMINI_MODEL = 'judge-model';
const { bestOf } = await import('../src/wit.js');

const reply = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
const LIST = '1) Первый вариант\n2) Второй вариант\n3) Третий вариант\n4) Четвёртый вариант\nЛУЧШИЙ: 1';
const isJudge = (opts) => /редактор юмора/i.test(JSON.parse(opts.body).systemInstruction.parts[0].text);
const run = (over = {}) => bestOf({ system: 's', prompt: 'p', context: 'ctx', direct: false, high: true, ...over });

test('отдельный редактор выбирает вместо самооценки модели (два запроса)', async () => {
  let n = 0;
  globalThis.fetch = async (url, opts) => (n++, reply(isJudge(opts) ? '3' : LIST));
  const r = await run();
  assert.equal(r.text, 'Третий вариант');
  assert.equal(n, 2);
});

test('редактор сказал 0: самовольную реплику не отправляем, на прямое — отвечаем', async () => {
  globalThis.fetch = async (url, opts) => reply(isJudge(opts) ? '0' : LIST);
  assert.equal((await run({ direct: false })).text, 'SKIP');
  assert.notEqual((await run({ direct: true })).text, 'SKIP');
});

test('редактор недоступен — берём первый годный вариант', async () => {
  globalThis.fetch = async (url, opts) => (isJudge(opts) ? new Response('down', { status: 503 }) : reply(LIST));
  assert.equal((await run()).text, 'Первый вариант');
});
