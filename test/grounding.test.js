import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-GROUND';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
process.env.GEMINI_MODEL = 'ground-model';
process.env.AI_RPM = '100';
const { isGrounded } = await import('../src/safety.js');
const { transcript, staleNote, revivePrompt, needlePrompt } = await import('../src/prompts.js');
const { pickNeedleTarget, runInitiative } = await import('../src/life.js');
const { app } = await import('../src/respond.js');
const { emptyMemory } = await import('../src/memory.js');

const H = 3600_000;
const LINES = ['скинула фотки после поездки, там всё в грязи', 'машину отмывала полдня, ужас', 'в понедельник отдам в мойку нормальную'];

test('опора на слова человека: точная цитата, неточная цитата, пересказ — да; выдумка — нет', () => {
  assert.ok(isGrounded('«машину отмывала полдня» — признайся, ты трактор вытаскивала?', LINES));
  assert.ok(isGrounded('«машину отмывала целых полдня» — драма', LINES)); // мелкая неточность цитаты
  assert.ok(isGrounded('Машину ты отмывала полдня, а в понедельник отдашь в мойку?', LINES)); // пересказ с совпадением слов
  assert.ok(!isGrounded('У тебя специфические ассоциации на понедельник, человеческая многоножка!', LINES)); // выдумка
  assert.ok(!isGrounded('«человеческая многоножка» — у тебя вкусы!', LINES)); // цитата, которой не было
  assert.ok(!isGrounded('Ты где пропадала?', LINES)); // нет опоры вообще
  assert.ok(!isGrounded('машину отмывала полдня', [])); // нет материала
});

test('контекст инициатив: возраст сообщений и недоверие к описанию фото', () => {
  const now = Date.now();
  const history = [
    { name: 'Дарина', text: '[фото: машина в грязи на дороге]', ts: now - 20 * H },
    { name: 'Руслан', text: 'доплывём', ts: now - 5 * H },
    { name: 'Катя', text: 'только что', ts: now - 60_000 },
  ];
  const t = transcript(history, 10, { ages: true });
  assert.match(t, /\[20 ч назад\] Дарина: \[фото, описание ИИ, может быть неточным: машина в грязи/);
  assert.match(t, /\[5 ч назад\] Руслан/);
  assert.doesNotMatch(t, /назад\] Катя/); // свежее без пометки
  assert.doesNotMatch(transcript(history, 10), /назад\]/); // без ages — как раньше
});

test('оживление: если разговор давно закончился, модели прямо сказано не обсуждать его как текущий', () => {
  const now = Date.now();
  const old = [{ name: 'Дарина', text: 'про грязь', ts: now - 20 * H }];
  const fresh = [{ name: 'Дарина', text: 'про грязь', ts: now - 10 * 60_000 }];
  assert.match(staleNote(old, now), /давно закончился/);
  assert.match(staleNote(old, now), /20 ч/);
  assert.equal(staleNote(fresh, now), '');
  assert.match(revivePrompt(old), /давно закончился/);
  assert.match(revivePrompt(old), /не придумывай события, предметы и темы, которых там нет/);
  assert.doesNotMatch(revivePrompt(fresh), /давно закончился/);
});

test('подкол: цель нужна со свежими (за сутки) сообщениями, а не только старыми', () => {
  const now = Date.now();
  const mk = (h) => ({
    history: [0, 1, 2, 3].map((i) => ({ id: i, uid: 1, name: 'Дарина', text: `что-то про машину ${i}`, ts: now - (h + i) * H })),
    users: { 1: { name: 'Дарина' } }, optOut: {}, leaveAlone: {}, needleLast: {}, roastLast: {},
  });
  assert.equal(pickNeedleTarget(mk(30), now), null); // писала, но позавчера: материал протух
  assert.equal(pickNeedleTarget(mk(2), now)?.uid, '1');
});

const sent = [];
app.telegram = { sendMessage: async (c, t) => (sent.push(t), { message_id: 100 + sent.length }) };
app.id = 99;
app.name = 'Батя';
const reply = (t) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] }));
const mkst = (lines) => ({
  history: lines.map((t, i) => ({ id: i + 1, uid: 5, name: 'Дарина', text: t, ts: Date.now() - (lines.length - i) * 600_000 })),
  users: { 5: { name: 'Дарина', username: 'Tatoshkd' } }, optOut: {}, memOff: {}, taboo: [], leaveAlone: {}, needleLast: {}, roastLast: {}, pokeLast: {},
  memory: emptyMemory(), taste: { liked: [], disliked: [], angles: {} },
  settings: { v: 2, activity: 4, tone: 'free', crude: 3, mutedUntil: 0, autonomy: true }, initLog: [], unsol: [],
});

test('выдуманный подкол («фотки грязи», которых не было) отбрасывается, бот молчит', async () => {
  sent.length = 0;
  globalThis.fetch = async () => reply('1) Дарина, у тебя специфические ассоциации: человеческая многоножка и фотки грязи!\n2) Ты опять про свою многоножку?\nЛУЧШИЙ: 1');
  await runInitiative(-1, mkst(['машину отмывала полдня', 'в понедельник отдам в мойку', 'ужас какой-то']), 'needle', 'd');
  assert.equal(sent.length, 0);
});

test('подкол по её реальным словам проходит и тегает', async () => {
  sent.length = 0;
  globalThis.fetch = async () => reply('1) Дарина, «машину отмывала полдня» — а в понедельник снова в мойку, это любовь или упрямство?\nЛУЧШИЙ: 1');
  await runInitiative(-1, mkst(['машину отмывала полдня', 'в понедельник отдам в мойку', 'ужас какой-то']), 'needle', 'd');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^@Tatoshkd, «машину отмывала полдня»/);
  assert.doesNotMatch(sent[0], /Дарина,/); // имя после тега убрано
});

test('материала меньше двух свежих фраз — не цепляемся вовсе', async () => {
  sent.length = 0;
  let calls = 0;
  globalThis.fetch = async () => (calls++, reply('1) что угодно\nЛУЧШИЙ: 1'));
  await runInitiative(-1, mkst(['одна фраза']), 'needle', 'd');
  assert.equal(sent.length, 0);
  assert.equal(calls, 0); // и к модели даже не обращаемся
});
