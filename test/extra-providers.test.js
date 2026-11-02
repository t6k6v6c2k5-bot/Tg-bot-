import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-EXTRA';
process.env.GEMINI_MODEL = 'extra-gem';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
process.env.MISTRAL_API_KEY = 'mk-1111, mk-2222';
process.env.MISTRAL_MODEL = 'mistral-test';
process.env.CEREBRAS_API_KEY = 'ck-3333';
process.env.EXTRA_LLMS = 'моя-сеть|https://llm.example.com/v1/|zk-4444|custom-model; битая|только-два';
process.env.AI_RPM = '100';
const { config } = await import('../src/config.js');
const { generate, aiStatus } = await import('../src/ai.js');

test('пресеты и EXTRA_LLMS собираются, битые записи игнорируются', () => {
  const by = Object.fromEntries(config.extraProviders.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(by).sort(), ['cerebras', 'mistral', 'моя-сеть']);
  assert.deepEqual(by.mistral.keys, ['mk-1111', 'mk-2222']);
  assert.deepEqual(by.mistral.models, ['mistral-test']);
  assert.equal(by.mistral.baseUrl, 'https://api.mistral.ai/v1');
  assert.equal(by['моя-сеть'].baseUrl, 'https://llm.example.com/v1'); // лишний слэш убран
  assert.ok(by.cerebras.models.length >= 1); // модель по умолчанию из пресета
});

test('когда Gemini недоступен, отвечает дополнительный провайдер с нужным адресом, ключом и телом', async () => {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    if (url.includes('googleapis')) return new Response('down', { status: 503 });
    const body = JSON.parse(opts.body);
    seen.push({ url, auth: opts.headers.authorization, model: body.model, sys: body.messages[0].role });
    if (url.startsWith('https://api.mistral.ai')) return new Response(JSON.stringify({ choices: [{ message: { content: 'ответ от mistral' } }] }));
    return new Response('x', { status: 500 });
  };
  const r = await generate({ system: 's', prompt: 'p', high: true });
  assert.ok(r);
  assert.equal(r.text, 'ответ от mistral');
  assert.match(r.provider, /^mistral:mistral-test:…\d{4}$/);
  assert.equal(seen[0].url, 'https://api.mistral.ai/v1/chat/completions');
  assert.match(seen[0].auth, /^Bearer mk-/);
  assert.equal(seen[0].model, 'mistral-test');
});

test('ключ одного провайдера упал — берём ключ другого того же провайдера', async () => {
  const keys = [];
  globalThis.fetch = async (url, opts) => {
    if (!url.includes('mistral')) return new Response('down', { status: 503 });
    keys.push(opts.headers.authorization);
    return opts.headers.authorization.endsWith('mk-1111')
      ? new Response('quota', { status: 429 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'ок со вторым ключом' } }] }));
  };
  // ключи Mistral крутятся по кругу; за несколько запросов хотя бы раз ответит второй ключ даже если первый в 429
  let got = null;
  for (let i = 0; i < 4 && !got; i++) got = await generate({ system: 's', prompt: 'p', high: true });
  assert.equal(got?.text, 'ок со вторым ключом');
});

test('статус для админки показывает дополнительных провайдеров', () => {
  const st = aiStatus();
  assert.deepEqual(st.extra.map((e) => e.name).sort(), ['cerebras', 'mistral', 'моя-сеть']);
});
