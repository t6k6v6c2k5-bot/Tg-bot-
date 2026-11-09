import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'al2-'));
process.env.ALERT_CHANNELS = 'kpszsu,oborona_kr';

const { isUrgentPost, alertsTick, _resetAlerts } = await import('../src/alerts.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');

const post = (id, ts, text) => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="kpszsu/${id}"><div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div><a class="tgme_widget_message_date"><time datetime="${new Date(ts).toISOString()}"></time></a></div></div>`;

test('«терміново в укриття / коридор» в местном канале — срочное, в чужом без города — нет', async () => {
  assert.equal(isUrgentPost('Терміново в укриття!'), true);
  assert.equal(isUrgentPost('Коридоримся, ховайтесь'), true);
  assert.equal(isUrgentPost('Укриття відкриті на ТЦ'), false);
  assert.equal(isUrgentPost('Криворіжжя локаційно чисто, вибухів немає'), false);

  _resetAlerts();
  const sent = [];
  app.telegram = { sendMessage: async (id, t) => (sent.push([id, t]), { message_id: sent.length }) };
  app.id = 1;
  const st = chat(-610);
  st.settings.alerts = true;
  const t0 = Date.now();
  const chPost = (ch, id, ts, text) => post(id, ts, text).replace('kpszsu/', `${ch}/`);
  let pages = { kpszsu: post(1, t0 - 1000, 'старый'), oborona_kr: chPost('oborona_kr', 1, t0 - 1000, 'старый') };
  const fetch2 = async (url) => {
    if (url.includes('ubilling')) return { ok: true, text: async () => JSON.stringify({ states: { 'Дніпропетровська область': { alertnow: false } } }) };
    const ch = url.split('/s/')[1];
    return { ok: true, text: async () => pages[ch] || '' };
  };
  await alertsTick(t0, fetch2); // baseline
  pages = {
    kpszsu: post(1, t0 - 1000, 'старый') + post(2, t0 + 1000, 'Терміново в укриття всім!'), // федеральный канал: без города не считаем
    oborona_kr: chPost('oborona_kr', 1, t0 - 1000, 'старый') + chPost('oborona_kr', 2, t0 + 2000, 'Терміново в укриття! Коридоримся!'),
  };
  await alertsTick(t0 + 40_000, fetch2);
  const mine = sent.filter((x) => x[0] === -610).map((x) => x[1]);
  assert.equal(mine.length, 1);
  assert.match(mine[0], /УВАГА! Щось летить на Кривий Ріг/);
  assert.match(mine[0], /t\.me\/oborona_kr\/2/);
});

test('«чисто / вийшов за межі» пересылаем только пока тревога идёт', async () => {
  _resetAlerts();
  const sent = [];
  app.telegram = { sendMessage: async (id, t) => (sent.push([id, t]), { message_id: sent.length + 500 }), pinChatMessage: async () => true, unpinChatMessage: async () => true, deleteMessage: async () => true };
  app.id = 1;
  const st = chat(-620);
  st.settings.alerts = true;
  let alarm = false;
  let pages = {};
  const chPost = (ch, id, ts, text) => post(id, ts, text).replace('kpszsu/', `${ch}/`);
  const fetchFn = async (url) => {
    if (url.includes('ubilling')) return { ok: true, text: async () => JSON.stringify({ states: { 'Дніпропетровська область': { alertnow: alarm } } }) };
    return { ok: true, text: async () => pages[url.split('/s/')[1]] || '' };
  };
  const t0 = Date.now();
  pages = { oborona_kr: chPost('oborona_kr', 1, t0 - 1000, 'старый') };
  await alertsTick(t0, fetchFn); // baseline
  const mine = () => sent.filter((x) => x[0] === -620).map((x) => x[1]);

  pages = { oborona_kr: chPost('oborona_kr', 1, t0 - 1000, 'старый') + chPost('oborona_kr', 2, t0 + 1000, 'Криворіжжя локаційно чисто 📡') };
  await alertsTick(t0 + 31_000, fetchFn); // тревоги нет: «чисто» не нужно
  assert.equal(mine().length, 0);

  alarm = true;
  await alertsTick(t0 + 62_000, fetchFn);
  assert.match(mine()[0], /ТРИВОГА/);
  pages = { oborona_kr: pages.oborona_kr + chPost('oborona_kr', 3, t0 + 63_000, 'Реактивний вийшов за межі області, без загроз для Кривого Рогу') };
  await alertsTick(t0 + 95_000, fetchFn); // тревога идёт: это важное обновление
  assert.match(mine().at(-1), /^ℹ️ Реактивний вийшов за межі/);
  assert.doesNotMatch(mine().at(-1), /УВАГА/);
});
