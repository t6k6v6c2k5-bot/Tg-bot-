import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-TIER';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
process.env.GEMINI_MODEL = 'fast-model';
process.env.GEMINI_SMART_MODEL = 'smart-model';
process.env.AI_RPM = '500';
const { app, respond } = await import('../src/respond.js');
const { emptyMemory } = await import('../src/memory.js');

const sent = [];
app.telegram = { sendMessage: async (c, t) => (sent.push(t), { message_id: 100 + sent.length }), setMessageReaction: async () => {} };
app.id = 99;
app.name = 'Батя';
const mkst = (q) => ({ optOut: {}, taboo: [], settings: { v: 2, tone: 'free', crude: 3, activity: 3, mutedUntil: 0 }, memOff: {}, memory: emptyMemory(), taste: { liked: [], disliked: [], angles: {} }, unsol: [], roastLast: {}, users: { 1: { name: 'Руслан' } }, history: [{ id: 1, uid: 1, name: 'Руслан', text: q, ts: Date.now() }] });

let seq = [];
globalThis.fetch = async (url) => (seq.push(url.includes('smart-model') ? 'smart' : 'fast'), new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '1) ответ\nЛУЧШИЙ: 1' }] } }] })));
let chatNo = 100;
const ask = async (q) => {
  seq = [];
  await respond(-(chatNo++), mkst(q), { mode: 'direct', replyTo: 1 });
  return seq;
};

test('болтовня идёт только на быстрой модели: суточный запас «умной» не тратится', async () => {
  for (const q of ['привет, как дела?', 'что на ужин?', 'ахах ну ты даёшь', 'купить телефон или потерпеть?']) {
    const s = await ask(q);
    assert.ok(s.length >= 1, q);
    assert.ok(s.every((x) => x === 'fast'), `${q}: ${s}`);
  }
});

test('объяснения, советы и вопросы про людей/чат идут на «умную» модель', async () => {
  for (const q of ['объясни, почему небо голубое', 'посоветуй, как правильно выбрать ноутбук', 'что такое ипотека', 'в чём разница между аннуитетом и дифференцированным']) {
    const s = await ask(q);
    assert.equal(s[0], 'smart', `${q}: ${s}`);
  }
  // вопрос о конкретном человеке (аналитика) — тоже умная
  const st = mkst('батя, что за Ваня?');
  st.users[2] = { name: 'Ваня', username: 'vanya', msgs: 5, lastSeen: Date.now() };
  seq = [];
  await respond(-999, st, { mode: 'direct', replyTo: 1 });
  assert.equal(seq[0], 'smart');
});
