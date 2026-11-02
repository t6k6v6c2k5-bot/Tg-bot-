import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-CLOSER';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
process.env.GEMINI_MODEL = 'closer-model';
process.env.AI_RPM = '100';
const { closerKind } = await import('../src/filter.js');
const { app } = await import('../src/respond.js');
const { processMessage } = await import('../src/pipeline.js');
const { emptyMemory } = await import('../src/memory.js');

test('реплики-точки распознаются', () => {
  const cases = { Понял: 'ack', 'Збс': 'ack', 'ок': 'ack', 'Ясно.': 'ack', 'ладно': 'ack', 'норм!': 'ack', 'Спасибо': 'thanks', 'спс': 'thanks', 'Батя, спасибо!': 'thanks', 'ахахах': 'laugh', 'лол': 'laugh', '))': 'laugh', '😂': 'laugh', '👍': 'emoji', '👍👍': 'emoji', 'батя, понял': 'ack' };
  for (const [t, k] of Object.entries(cases)) assert.equal(closerKind(t), k, t);
});

test('вопросы и содержательные реплики — не точки', () => {
  for (const t of ['понял?', 'а почему?', 'расскажи ещё что-то', 'Набор слов', 'нет', 'ну и что дальше', 'ок, а теперь расскажи про Крым', 'збс, а что насчёт ужина?', 'батя, что на ужин?']) assert.equal(closerKind(t), null, t);
});

// ---- сквозной: processMessage ----
const sent = [];
let fetches = 0;
const reactions = [];
app.telegram = { sendMessage: async (c, t) => (sent.push(t), { message_id: 500 + sent.length }), setMessageReaction: async (c, m, r) => reactions.push(r[0].emoji) };
app.id = 99;
app.username = 'batya_bot';
app.name = 'Батя';
globalThis.fetch = async () => (fetches++, new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '1) Ответ\nЛУЧШИЙ: 1' }] } }] })));
const ctx = { chat: { id: -1, type: 'supergroup' } };
const mkst = (history) => ({ optOut: {}, taboo: [], settings: { v: 2, tone: 'free', crude: 3, activity: 3, mutedUntil: 0, autonomy: true }, memOff: {}, memory: emptyMemory(), taste: { liked: [], disliked: [], angles: {} }, unsol: [], roastLast: {}, users: { 1: { name: 'Влад' } }, rosterAt: Date.now(), sinceLearn: 0, lastLearnAt: Date.now(), lastReactAt: 0, hourHist: Array(24).fill(0), history });
const T = Date.now();
const botMsg = (text, id) => ({ id, uid: 99, name: 'Батя', text, ts: T - 5000, bot: true });
const humanMsg = (text, id) => ({ id, uid: 1, name: 'Влад', text, ts: T });
const msg = (text, replyId) => ({ message_id: 900, from: { id: 1, first_name: 'Влад' }, reply_to_message: { message_id: replyId, from: { id: 99 } }, text });

test('«Понял» в ответ на реплику бота: не отвечаем и не обращаемся к ИИ', async () => {
  sent.length = 0;
  fetches = 0;
  const st = mkst([botMsg('Влад, ты мне память до заводских скинул.', 7), humanMsg('Понял', 900)]);
  await processMessage(ctx, st, msg('Понял', 7), { text: 'Понял' });
  assert.equal(sent.length, 0);
  assert.equal(fetches, 0);
});

test('«да» в ответ на ВОПРОС бота — это ответ, бот продолжает', async () => {
  sent.length = 0;
  fetches = 0;
  const st = mkst([botMsg('Хочешь анекдот?', 7), humanMsg('да', 900)]);
  await processMessage(ctx, st, msg('да', 7), { text: 'да' });
  assert.ok(fetches >= 1);
  assert.equal(sent.length, 1);
});

test('обычная реплика боту без точки получает ответ', async () => {
  sent.length = 0;
  fetches = 0;
  const st = mkst([botMsg('Что-то сказал.', 7), humanMsg('расскажи ещё что-то', 900)]);
  await processMessage(ctx, st, msg('расскажи ещё что-то', 7), { text: 'расскажи ещё что-то' });
  assert.equal(sent.length, 1);
});
