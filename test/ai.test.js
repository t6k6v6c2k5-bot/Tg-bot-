import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-AAAA';
process.env.GEMINI_API_KEY_2 = 'key-BBBB';
process.env.GEMINI_API_KEYS = 'key-CCCC, key-AAAA'; // дубль должен схлопнуться
process.env.GEMINI_MODEL = 'bad-model,good-model';
delete process.env.GROK_API_KEY;
const { config } = await import('../src/config.js');
const { generate } = await import('../src/ai.js');

const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'привет' }] } }] }));
const keyOf = (opts) => opts.headers['x-goog-api-key'];

test('ключи из разных переменных собираются без дублей', () => {
  assert.deepEqual(config.geminiKeys.sort(), ['key-AAAA', 'key-BBBB', 'key-CCCC']);
});

test('упала модель — пробуем следующую; упавшая пара отдыхает', async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(`${url.split('/models/')[1].split(':')[0]}|${keyOf(opts)}`);
    return url.includes('bad-model') ? new Response('quota', { status: 429 }) : ok();
  };
  const a = await generate({ system: 's', prompt: 'p' });
  assert.match(a.provider, /^gemini:good-model:/);
  const badBefore = calls.filter((c) => c.startsWith('bad-model')).length;
  assert.ok(badBefore >= 1 && badBefore <= 3);
  await generate({ system: 's', prompt: 'p' });
  await generate({ system: 's', prompt: 'p' });
  // те пары «модель+ключ», что уже падали, повторно не дёргались
  const bad = calls.filter((c) => c.startsWith('bad-model'));
  assert.equal(new Set(bad).size, bad.length);
});

test('ключ одного аккаунта упал — работает ключ другого, нагрузка делится по кругу', async () => {
  const used = [];
  globalThis.fetch = async (url, opts) => {
    if (!url.includes('good-model')) return new Response('x', { status: 503 });
    used.push(keyOf(opts));
    return keyOf(opts) === 'key-BBBB' ? new Response('quota', { status: 429 }) : ok();
  };
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const r = await generate({ system: 's', prompt: 'p', high: true });
    assert.ok(r, 'ответ должен прийти, пока жив хотя бы один ключ');
    seen.add(r.provider.slice(-4));
  }
  assert.ok(!seen.has('BBBB')); // ответы шли с живых ключей
  assert.ok(seen.size >= 2); // и делились между ними
  assert.equal(used.filter((k) => k === 'key-BBBB').length, 1); // упавший ключ получил одну попытку и ушёл на паузу
});

test('в логах и результате ключ не светится целиком', async () => {
  globalThis.fetch = async () => ok();
  const r = await generate({ system: 's', prompt: 'p', high: true });
  assert.ok(r && !r.provider.includes('key-'));
});
