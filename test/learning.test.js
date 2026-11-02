import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-LEARN';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
process.env.GEMINI_MODEL = 'learn-model,learn-model-2';
const { emptyMemory, quickFacts, quickMemes, learn, learnBacklog } = await import('../src/memory.js');
const { pickAngle, repetition, styleBlock, ANGLES, trimEmoji } = await import('../src/variety.js');
const { recordFeedback } = await import('../src/taste.js');

const mk = (over = {}) => ({ history: [], users: { 1: { name: 'Ваня' }, 2: { name: 'Маша' } }, memory: emptyMemory(), memOff: {}, taste: { liked: [], disliked: [], angles: {} }, learnedUpTo: 0, sinceLearn: 0, ...over });
const msg = (uid, name, text, ts, extra = {}) => ({ id: ts, uid, name, text, ts, ...extra });

test('факты записываются правилами без ИИ, чувствительное отсекается', () => {
  const st = mk();
  quickFacts(st, 1, 'я обожаю пиццу с ананасами!');
  quickFacts(st, 1, 'вчера играл в доту до утра, я играю в Dota 2');
  quickFacts(st, 2, 'у меня есть кот Барсик');
  quickFacts(st, 2, 'я люблю свою жену'); // семья — не записываем
  quickFacts(st, 2, 'у меня болит голова, люблю лечиться таблетками'); // здоровье — не записываем
  const f1 = st.memory.users[1].map((f) => f.t);
  assert.ok(f1.some((t) => /любит пиццу с ананасами/.test(t)), f1.join('|'));
  assert.ok(f1.some((t) => /играет в Dota 2/.test(t)));
  assert.ok(st.memory.users[2].some((f) => /питомец: кот/.test(f.t)));
  assert.ok(!st.memory.users[2].some((f) => /жен|таблет/.test(f.t)));
  st.memOff[1] = true;
  assert.equal(quickFacts(st, 1, 'я люблю чай'), 0); // /забудь уважается
});

test('мемы: фраза, которую повторяют разные люди', () => {
  const st = mk();
  ['ананасовая мафия', 'Ананасовая мафия!', 'ананасовая мафия'].forEach((t, i) => st.history.push(msg(1 + (i % 2), 'x', t, i + 1)));
  st.history.push(msg(1, 'Ваня', 'одинокая фраза тут', 9));
  assert.equal(quickMemes(st), 1);
  assert.match(st.memory.memes[0].t, /ананасовая мафия/i);
});

const fill = (st, n = 14) => {
  for (let i = 0; i < n; i++) st.history.push(msg(1 + (i % 2), i % 2 ? 'Маша' : 'Ваня', `сообщение ${i} про котов`, 1000 + i));
};
const answer = (obj) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }));

test('очередь обучения: одна модель упала — учится другая, курсор сдвигается', async () => {
  const st = mk();
  fill(st);
  assert.equal(learnBacklog(st), 14);
  globalThis.fetch = async (url) => (url.includes('learn-model-2') ? answer({ users: { Маша: ['любит котов'] }, memes: [], style: 'коротко' }) : new Response('down', { status: 503 }));
  const added = await learn(1, st);
  assert.ok(added >= 1, `добавлено ${added}`);
  assert.equal(st.learnedUpTo, 1013);
  assert.equal(learnBacklog(st), 0);
  assert.ok(st.memory.users[2].some((f) => /котов/.test(f.t)));
});

test('очередь обучения: все модели недоступны — курсор стоит, сообщения не теряются', async () => {
  const st = mk();
  fill(st);
  globalThis.fetch = async () => new Response('down', { status: 503 });
  assert.equal(await learn(2, st), -1);
  assert.equal(st.learnedUpTo, 0);
  assert.equal(learnBacklog(st), 14); // всё ещё в очереди для следующей попытки
});

test('очередь обучения: большая очередь разбирается порциями', async () => {
  const st = mk({ learnedUpTo: 999 });
  fill(st, 100);
  globalThis.fetch = async () => answer({ users: {}, memes: [], style: '' });
  const { config } = await import('../src/config.js');
  assert.ok(config.geminiKeys.length >= 1);
  // паузы прошлых тестов могли закрыть модель — тогда проверяем лишь сохранность курсора
  const r = await learn(3, st);
  if (r >= 0) assert.ok(st.learnedUpTo < 1099 && learnBacklog(st) > 0, 'остаток очереди должен остаться на следующий раз');
  else assert.equal(st.learnedUpTo, 999);
});

test('приёмы чередуются и не повторяют прошлый', () => {
  const st = mk({ lastAngle: 'dry' });
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(pickAngle(st, Math.random).id);
  assert.ok(!seen.has('dry'));
  assert.ok(seen.size >= 6);
  assert.ok(ANGLES.length >= 10);
});

test('удачные приёмы выбираются чаще', () => {
  const st = mk();
  st.taste.angles = { absurd: { n: 9, ema: 1 }, dry: { n: 9, ema: 0 } };
  let absurd = 0;
  let dry = 0;
  for (let i = 0; i < 2000; i++) {
    const id = pickAngle(st).id;
    if (id === 'absurd') absurd++;
    if (id === 'dry') dry++;
  }
  assert.ok(absurd > dry * 1.5, `${absurd} vs ${dry}`);
});

test('заезженное и похожее отсекается', () => {
  const st = mk({ history: [msg(0, 'Батя', 'Поешь нормально и надень шапку, орёл', 1, { bot: true }), msg(0, 'Батя', 'Ну ты даёшь, молодёжь', 2, { bot: true })] });
  assert.ok(repetition('Главное — шапку надень', st).includes('шапк'));
  assert.deepEqual(repetition('Подождите, а при чём тут тракторы?', st), []);
  const st2 = mk({ history: [msg(0, 'Батя', 'Пицца с ананасами это преступление против человечества', 1, { bot: true })] });
  assert.ok(repetition('Ананасы на пицце — преступление против человечества', st2).length > 0);
  assert.match(styleBlock(st, ANGLES[0], ['шапк']), /НЕ используй.*шапк/);
});

test('обратная связь: смех, недовольство и ответ боту влияют на вкус', () => {
  const st = mk();
  st.history = [msg(0, 'Батя', 'Это шутка про ананасы', 100, { bot: true, angle: 'absurd', id: 7 }), msg(1, 'Ваня', 'ахахах', 101)];
  assert.equal(recordFeedback(st, { text: 'ахахах' }, 102), 'liked');
  assert.equal(st.taste.liked.length, 1);
  assert.ok(st.taste.angles.absurd.ema > 0.5);
  assert.equal(recordFeedback(st, { text: 'ахахах' }, 103), null); // повторно ту же реплику не засчитываем

  const st2 = mk();
  st2.history = [msg(0, 'Батя', 'Вечно одно и то же', 100, { bot: true, angle: 'dry', id: 8 }), msg(2, 'Маша', 'батя, не смешно, надоел', 101)];
  assert.equal(recordFeedback(st2, { text: 'батя, не смешно, надоел' }, 102), 'disliked');
  assert.ok(st2.taste.angles.dry.ema < 0.5);
  assert.equal(st2.taste.disliked[0].t, 'Вечно одно и то же');

  const st3 = mk();
  st3.history = [msg(0, 'Батя', 'Что-то сказал', 100, { bot: true, angle: 'short', id: 9 }), msg(1, 'Ваня', 'а почему?', 101)];
  assert.equal(recordFeedback(st3, { text: 'а почему?', reply_to_message: { message_id: 9 } }, 102), 'engaged');
  assert.equal(recordFeedback(mk({ history: [msg(1, 'Ваня', 'просто текст', 101)] }), { text: 'просто текст' }, 102), null);
});

test('одинаковые начала реплик отсекаются, эмодзи не штампуются', () => {
  const st = mk({ history: [msg(0, 'Батя', 'Слушай, Ваня, возьми гречку 🍲', 1, { bot: true }), msg(0, 'Батя', 'Слушай, Маша, там всё ясно ☕', 2, { bot: true })] });
  assert.ok(repetition('Слушай, Дима, а ты проверял?', st).length > 0); // третье «Слушай» подряд
  assert.ok(repetition('Слушай, Ваня, возьми рис', st).length > 0); // то же начало из двух слов
  assert.deepEqual(repetition('Хм, а при чём тут тракторы?', st), []);
  assert.equal(trimEmoji('Красота 🔥', st), 'Красота'); // эмодзи уже были в обеих последних репликах
  assert.equal(trimEmoji('Красота 🔥', mk()), 'Красота 🔥');
});
