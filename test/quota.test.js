import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-QUOTA';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
process.env.GEMINI_MODEL = 'fast-model';
process.env.GEMINI_SMART_MODEL = 'smart-model';
process.env.AI_RPM = '500';
const { generate, aiStatus } = await import('../src/ai.js');
const { app, respond } = await import('../src/respond.js');
const { emptyMemory } = await import('../src/memory.js');

const ok = (t = 'ответ') => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] }));
// настоящий формат 429 от Google с суточной квотой
const dailyQuota = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        message: 'You exceeded your current quota, please check your plan and billing details. ' + 'x'.repeat(300),
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '69990s' },
        ],
      },
    }),
    { status: 429 },
  );

test('суточная квота: бот ждёт ровно столько, сколько сказал Google, и не долбит модель каждые минуты', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return url.includes('smart-model') ? dailyQuota() : ok();
  };
  const a = await generate({ system: 's', prompt: 'p', tier: 'smart', high: true });
  assert.match(a.provider, /fast-model/); // умная исчерпана — ответила быстрая
  const pause = aiStatus().pauses.find((p) => p.id.includes('smart-model'));
  assert.ok(pause, 'умная модель должна быть на паузе');
  assert.ok(pause.seconds > 69_000 && pause.seconds <= 69_990, `пауза ${pause.seconds} с`);
  const before = urls.filter((u) => u.includes('smart-model')).length;
  for (let i = 0; i < 5; i++) await generate({ system: 's', prompt: 'p', tier: 'smart', high: true });
  assert.equal(urls.filter((u) => u.includes('smart-model')).length, before); // к исчерпанной модели больше не ходили
});
