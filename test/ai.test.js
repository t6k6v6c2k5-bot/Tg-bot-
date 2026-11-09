import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-AAAA';
process.env.GEMINI_API_KEY_2 = 'key-BBBB';
process.env.GEMINI_API_KEYS = 'key-CCCC, key-AAAA'; // дубль должен схлопнуться
process.env.GEMINI_MODEL = 'bad-model,good-model';
delete process.env.GROK_API_KEY;
process.env.GROQ_API_KEY = 'gsk_test_1111';
process.env.GROQ_API_KEY_2 = 'gsk_test_2222';
process.env.GROQ_MODEL = 'openai/gpt-oss-test';
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

test('таймаут/503 — проблема модели: остальные ключи этой модели не дёргаем, идём к следующей модели', async () => {
  const hits = [];
  globalThis.fetch = async (url, opts) => {
    const model = url.split('/models/')[1].split(':')[0];
    hits.push(`${model}|${opts.headers['x-goog-api-key']}`);
    return model === 'bad-model' ? new Response('overloaded', { status: 503 }) : ok();
  };
  // сбросим паузы прошлых тестов: подождать нельзя, поэтому проверяем по числу обращений к bad-model в этой серии
  const before = hits.length;
  await generate({ system: 's', prompt: 'p', high: true });
  const badNow = hits.slice(before).filter((h) => h.startsWith('bad-model'));
  assert.ok(badNow.length <= 1, `к перегруженной модели ходили ${badNow.length} раз(а)`);
  const again = hits.length;
  await generate({ system: 's', prompt: 'p', high: true });
  assert.equal(hits.slice(again).filter((h) => h.startsWith('bad-model')).length, 0); // на паузе у всех ключей
});

test('Gemini недоступен целиком — отвечает Groq (с запросом в формате OpenAI)', async () => {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(url);
    if (url.includes('groq.com')) {
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'openai/gpt-oss-test');
      assert.equal(body.messages[0].role, 'system');
      assert.match(opts.headers.authorization, /^Bearer gsk_test_/);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ответ от groq' } }] }));
    }
    return new Response('down', { status: 503 });
  };
  // паузы от прошлых тестов могли уже закрыть Gemini — тогда ответ от Groq придёт сразу
  const r = await generate({ system: 's', prompt: 'p', high: true });
  assert.ok(r, 'ответ должен прийти');
  assert.match(r.provider, /^groq:openai\/gpt-oss-test:…\d{4}$/);
  assert.equal(r.text, 'ответ от groq');
});

test('ключи Groq читаются из нескольких переменных', () => {
  assert.deepEqual(config.groqKeys.sort(), ['gsk_test_1111', 'gsk_test_2222']);
});

test('400 «не удалось собрать JSON» не отключает модель для обычных запросов', async () => {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    if (!url.includes('groq.com')) return new Response('down', { status: 503 });
    const body = JSON.parse(opts.body);
    seen.push({ json: Boolean(body.response_format) });
    return body.messages[1].content === 'json-запрос'
      ? new Response('{"error":{"message":"Failed to generate JSON. Please adjust your prompt."}}', { status: 400 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'обычный ответ' } }] }));
  };
  const bad = await generate({ system: 's', prompt: 'json-запрос', json: true, high: true });
  assert.equal(bad, null); // запрос не удался, но...
  const ok = await generate({ system: 's', prompt: 'обычный', high: true });
  assert.equal(ok?.text, 'обычный ответ'); // ...модель по-прежнему доступна обычным запросам
  assert.ok(seen.every((r) => !r.json)); // для gpt-oss принудительный JSON-режим не включаем
});

test('Claude (Anthropic) — первый в цепочке, если задан ключ; формат запроса и ответа', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-1234';
  const mod = await import(`../src/ai.js?anthropic=${Date.now()}`); // свежий импорт с новым конфигом
  const { config: c } = await import('../src/config.js');
  assert.ok(c.anthropicKeys.length === 0 || c.anthropicKeys[0] === 'sk-ant-test-1234');
  // конфиг уже загружен без ключа: добавляем его как это сделала бы переменная окружения
  c.anthropicKeys.push('sk-ant-test-1234');
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push([url, opts.headers, JSON.parse(opts.body)]);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ответ от Claude' }] }));
  };
  const r = await mod.generate({ system: 'sys', prompt: 'привет', maxTokens: 50, temperature: 1.3, json: true });
  assert.match(r.provider, /^anthropic:claude-haiku/);
  assert.equal(r.text, 'ответ от Claude');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0][1]['x-api-key'], 'sk-ant-test-1234');
  assert.equal(seen[0][1]['anthropic-version'], '2023-06-01');
  assert.equal(seen[0][2].messages[0].content, 'привет');
  assert.equal(seen[0][2].temperature, 1); // у Anthropic максимум 1
  assert.match(seen[0][2].system, /ТОЛЬКО валидный JSON/);
  // для «умных» вопросов — Sonnet
  seen.length = 0;
  const s = await mod.generate({ system: 's', prompt: 'p', tier: 'smart' });
  assert.match(s.provider, /^anthropic:claude-sonnet/);
  c.anthropicKeys.pop();
  delete process.env.ANTHROPIC_API_KEY;
});
