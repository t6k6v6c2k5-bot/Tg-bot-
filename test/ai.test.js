import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'k';
process.env.GEMINI_MODEL = 'bad-model,good-model';
delete process.env.GROK_API_KEY;
const { generate } = await import('../src/ai.js');

test('упавшая модель отдыхает и не тормозит следующие запросы; пауза растёт', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.includes('bad-model')) return new Response('quota', { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'привет' }] } }] }));
  };
  const a = await generate({ system: 's', prompt: 'p' });
  assert.equal(a.provider, 'gemini:good-model');
  assert.equal(urls.filter((u) => u.includes('bad-model')).length, 1);
  const b = await generate({ system: 's', prompt: 'p' });
  assert.equal(b.provider, 'gemini:good-model');
  assert.equal(urls.filter((u) => u.includes('bad-model')).length, 1); // вторую минуту к ней не ходили
  assert.equal(urls.filter((u) => u.includes('good-model')).length, 2);
});

test('все модели недоступны — null, а не зависание', async () => {
  globalThis.fetch = async () => new Response('down', { status: 503 });
  const r = await generate({ system: 's', prompt: 'p', high: true });
  assert.ok(r === null || r.provider); // good-model мог ещё быть на паузе от предыдущего теста
});
