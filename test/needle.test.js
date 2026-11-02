import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'key-NEEDLE';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
process.env.GEMINI_MODEL = 'needle-model';
process.env.AI_RPM = '100';
process.env.ROAST_COOLDOWN_HOURS = '3';
const { pickNeedleTarget, withMention, pickInitiative, runInitiative } = await import('../src/life.js');
const { app, say } = await import('../src/respond.js');
const { isLeaveMeAlone } = await import('../src/taste.js');
const { emptyMemory } = await import('../src/memory.js');

const H = 3600_000;
const NOW = 1_800_000_000_000;

function mk(over = {}) {
  const history = [];
  // Ваня и Маша активны последние 2 дня; Дима писал давно; Оля пишет мало
  for (let i = 0; i < 6; i++) history.push({ id: i, uid: 1, name: 'Ваня', text: `Ваня говорит про дедлайн ${i}`, ts: NOW - 8 * H - i * 600_000 });
  for (let i = 0; i < 5; i++) history.push({ id: 10 + i, uid: 2, name: 'Маша', text: `Маша обещает вернуться ${i}`, ts: NOW - 9 * H - i * 600_000 });
  history.push({ id: 20, uid: 3, name: 'Дима', text: 'давно писал', ts: NOW - 6 * 24 * H });
  history.push({ id: 21, uid: 4, name: 'Оля', text: 'раз', ts: NOW - 9 * H });
  history.sort((a, b) => a.ts - b.ts);
  return {
    history,
    users: { 1: { name: 'Ваня', username: 'vanya' }, 2: { name: 'Маша' }, 3: { name: 'Дима' }, 4: { name: 'Оля' } },
    optOut: {}, memOff: {}, taboo: [], memory: emptyMemory(), taste: { liked: [], disliked: [], angles: {} },
    settings: { v: 2, activity: 4, tone: 'free', crude: 3, mutedUntil: 0, autonomy: true },
    initLog: [], lastInitAt: 0, initTryAt: 0, ignored: 0, lastReviveAt: 0, lastTaleAt: 0, lastGreetDay: 'x', pokeLast: {},
    needleLast: {}, lastNeedleAt: 0, leaveAlone: {}, roastLast: {}, unsol: [],
    ...over,
  };
}

test('цели для подкола: только недавно активные и с материалом', () => {
  const st = mk();
  const seen = new Set();
  for (let i = 0; i < 80; i++) seen.add(pickNeedleTarget(st, NOW, Math.random)?.uid);
  assert.deepEqual([...seen].sort(), ['1', '2']); // Дима давно молчит, у Оли один пост
});

test('защиты: не подкалывать, просил отстать, недавно цеплялись, недавно прожарили', () => {
  assert.deepEqual(pickNeedleTarget(mk({ optOut: { 1: true, 2: true } }), NOW), null);
  const st = mk({ leaveAlone: { 1: NOW - 2 * 24 * H }, needleLast: { 2: NOW - 3 * H } });
  assert.equal(pickNeedleTarget(st, NOW), null);
  assert.equal(pickNeedleTarget(mk({ leaveAlone: { 1: NOW - 8 * 24 * H }, optOut: { 2: true } }), NOW)?.uid, '1'); // неделя прошла
  assert.equal(pickNeedleTarget(mk({ roastLast: { 1: NOW - H, 2: NOW - H } }), NOW), null); // только что жарили
});

test('на мягком тоне и низкой активности подкол не выбирается', () => {
  const pick = (st) => {
    for (let k = 0; k < 40; k++) if (pickInitiative(st, NOW, { hour: 15, today: 'd', rng: () => (k % 7) / 7 }) === 'needle') return true;
    return false;
  };
  assert.equal(pick(mk({ settings: { v: 2, activity: 4, tone: 'soft', crude: 3, mutedUntil: 0, autonomy: true } })), false);
  assert.equal(pick(mk({ settings: { v: 2, activity: 2, tone: 'free', crude: 3, mutedUntil: 0, autonomy: true } })), false);
  assert.equal(pick(mk({ lastNeedleAt: NOW - H })), false); // не чаще раза в 4 часа
});

test('тег: по @нику или через text_mention для людей без ника', () => {
  assert.deepEqual(withMention({ name: 'Ваня', username: 'vanya' }, 1, 'ну и где отчёт?'), { text: '@vanya, ну и где отчёт?' });
  assert.deepEqual(withMention({ name: 'Ваня', username: 'vanya' }, 1, '@Vanya, уже тут'), { text: '@Vanya, уже тут' });
  const m = withMention({ name: 'Маша' }, 2, 'ну и где отчёт?');
  assert.equal(m.text, 'Маша, ну и где отчёт?');
  assert.deepEqual(m.entities, [{ type: 'text_mention', offset: 0, length: 4, user: { id: 2 } }]);
  assert.equal(withMention({ name: 'Маша' }, 2, 'Маша, ты где?').text, 'Маша, ты где?'); // имя не дублируем
  assert.equal(withMention({ name: 'Ваня', username: 'vanya' }, 1, 'В понедельник начнёшь?').text, '@vanya, в понедельник начнёшь?'); // регистр после тега
  assert.equal(withMention({ name: 'Ваня', username: 'vanya' }, 1, 'Ты где?').text, '@vanya, ты где?');
  assert.equal(withMention({ name: 'Ваня', username: 'vanya' }, 1, 'СДВГ у тебя, что ли?').text, '@vanya, СДВГ у тебя, что ли?'); // аббревиатуры не трогаем
  assert.equal(withMention({ name: 'Ваня', username: 'vanya' }, 1, 'Ваня, ты где?').text, '@vanya, Ваня, ты где?'); // имя адресата не трогаем
});

test('просьба отстать распознаётся', () => {
  for (const t of ['отстань', 'Отвали уже', 'хватит меня доставать', 'не трогай меня', 'оставь меня в покое', 'не тегай меня']) assert.ok(isLeaveMeAlone(t), t);
  for (const t of ['а почему?', 'хватит ли денег', 'мне это нравится']) assert.ok(!isLeaveMeAlone(t), t);
});

const sent = [];
app.telegram = { sendMessage: async (c, t, o) => (sent.push({ t, o }), { message_id: 500 + sent.length }) };
app.id = 99;
app.name = 'Батя';
const reply = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));

test('say передаёт entities, а если Telegram их не принял — отправляет без тега', async () => {
  sent.length = 0;
  const st = mk();
  const e = [{ type: 'text_mention', offset: 0, length: 4, user: { id: 2 } }];
  await say(-1, st, 'Маша, привет', undefined, { entities: e });
  assert.deepEqual(sent[0].o.entities, e);
  assert.equal(st.history.at(-1).entities, undefined); // служебное поле не пишем в историю
  let n = 0;
  app.telegram.sendMessage = async (c, t, o) => {
    if (o.entities && n++ === 0) throw new Error('entities rejected');
    sent.push({ t, o });
    return { message_id: 700 };
  };
  await say(-1, st, 'Маша, ещё раз', undefined, { entities: e });
  assert.equal(sent.at(-1).o.entities, undefined);
});

test('инициатива «подкол»: тегает человека, фиксирует паузы и не повторяет цель', async () => {
  sent.length = 0;
  app.telegram.sendMessage = async (c, t, o) => (sent.push({ t, o }), { message_id: 800 + sent.length });
  globalThis.fetch = async () => reply('1) Ваня, ты третий день «почти закончил» дедлайн, где результат?\nЛУЧШИЙ: 1');
  const st = mk({ optOut: { 2: true } }); // единственная возможная цель — Ваня
  await runInitiative(-1, st, 'needle', 'd');
  assert.equal(sent.length, 1);
  assert.match(sent[0].t, /^@vanya, /);
  assert.ok(st.needleLast['1'] > 0 && st.lastNeedleAt > 0 && st.roastLast['1'] > 0);
  assert.equal(pickNeedleTarget(st, Date.now()), null); // сутки к нему не цепляемся
});
