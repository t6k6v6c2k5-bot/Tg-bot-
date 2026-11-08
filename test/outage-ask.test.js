import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'));
process.env.BOT_TZ = 'UTC';

const { isLightQuestion, looseTimes, analyzeWindow, handleLightQuestion, statusNow } = await import('../src/outage-ask.js');
const { _resetOutageCache, setUserGroup } = await import('../src/outage.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');

const NOW = Date.UTC(2026, 10, 9, 8, 40); // 08:40 UTC
const T0 = Math.floor(NOW / 86400_000) * 86400; // сегодняшняя полночь, сек
// 6.2: сегодня без света 07:00–14:00 и 17:30–21:30; завтра 03:30–07:30
const todaySched = { 8: 'no', 9: 'no', 10: 'no', 11: 'no', 12: 'no', 13: 'no', 14: 'no', 18: 'second', 19: 'no', 20: 'no', 21: 'first' };
const tomorrowSched = { 4: 'second', 5: 'no', 6: 'no', 7: 'no', 8: 'first' };
let withTomorrow = true;
const mkData = () => ({ fact: { data: { [T0]: { 'GPV6.2': todaySched, 'GPV1.1': {} }, ...(withTomorrow ? { [T0 + 86400]: { 'GPV6.2': tomorrowSched, 'GPV1.1': {} } } : {}) } } });
const fakeFetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(mkData())) });

const ask = async (text, extract, st = chat(-900)) => {
  const sent = [];
  app.telegram = { sendMessage: async (id, t) => (sent.push(t), { message_id: sent.length }) };
  app.id = 1;
  _resetOutageCache();
  await handleLightQuestion({ chatId: -900, st, from: { id: 5, first_name: 'Влад' }, text, replyTo: 1, now: NOW, extract, fetchFn: fakeFetch });
  return sent[0];
};

test('что считается вопросом про свет', () => {
  assert.ok(isLightQuestion('батя, когда будет свет у 3.1?'));
  assert.ok(isLightQuestion('мне нужно зарядить машину у игоря у него график 6.2'));
  assert.ok(isLightQuestion('какая у меня очередь'));
  assert.ok(!isLightQuestion('график работы на завтра'));
  assert.ok(!isLightQuestion('как дела'));
});

test('запасной разбор времени без ИИ', () => {
  assert.deepEqual(looseTimes('поставлю в 10 вечера, заберу в 7 утра'), [22 * 60, 7 * 60]);
});

test('окно зарядки: 22:00 → 07:00, график на завтра есть', () => {
  withTomorrow = true;
  const r = analyzeWindow(mkData(), 'GPV6.2', 22 * 60, 1440 + 7 * 60, NOW);
  assert.equal(r.total, 540);
  assert.equal(r.onMin, 330); // 22:00–03:30
  assert.equal(r.offMin, 210); // 03:30–07:00
  assert.deepEqual(r.longest, [1320, 1650]);
});

test('вопрос про зарядку у Игоря: считает и отвечает', async () => {
  withTomorrow = true;
  const out = await ask('батя, зарядить машину у игоря, у него 6.2, поставлю в 10 вечера, заберу в 7 утра', async () => ({ queue: '6.2', intent: 'window', start: '22:00', end: '07:00', start_day: null }));
  assert.match(out, /Черга 6\.2/);
  assert.match(out, /Свет будет 5,5 ч из 9 ч/);
  assert.match(out, /22:00–03:30 \(завтра\)/);
  assert.match(out, /Без света: 03:30–07:00 \(завтра\)/);
});

test('графика на завтра ещё нет — честно предупреждает', async () => {
  withTomorrow = false;
  const out = await ask('нужно зарядить с 22 до 7, очередь 6.2', async () => ({ queue: '6.2', intent: 'window', start: '22:00', end: '07:00' }));
  assert.match(out, /Свет будет 2 ч из 9 ч/);
  assert.match(out, /Графика на завтра ещё нет/);
  withTomorrow = true;
});

test('нужно N часов подряд', async () => {
  const out = await ask('зарядка 6 часов, 6.2, с 22 до 7', async () => ({ queue: '6.2', intent: 'window', start: '22:00', end: '07:00', need_hours: 6 }));
  assert.match(out, /6 ч подряд не набирается: максимум 5,5 ч/);
});

test('очередь берётся из записанной у человека, если не названа; без неё — спрашивает', async () => {
  const st = chat(-901);
  let out = await ask('есть ли сейчас свет', async () => ({ intent: 'status' }), st);
  assert.match(out, /Не знаю, какая очередь/);
  setUserGroup(st, { id: 5, first_name: 'Влад' }, 'GPV6.2');
  out = await ask('есть ли сейчас свет', async () => ({ intent: 'status' }), st);
  assert.match(out, /Сейчас света нет по графику/); // 08:40 — внутри 07:00–14:00
  assert.match(out, /Включат в 14:00/);
});

test('ИИ недоступен — запасной разбор по правилам', async () => {
  const out = await ask('поставлю заряжаться в 10 вечера, заберу в 7 утра, очередь 6.2', async () => null);
  assert.match(out, /Свет будет 5,5 ч из 9 ч/);
});

test('statusNow считает ближайшее изменение', () => {
  const s = statusNow(mkData(), 'GPV6.2', NOW);
  assert.equal(s.on, false);
  assert.equal(s.until, 14 * 60);
});
