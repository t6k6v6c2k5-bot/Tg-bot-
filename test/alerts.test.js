import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'al-'));

const { parseChannel, fetchAlertState, alertsTick, alertStatusText, isAlertQuestion, startText, clearText, _resetAlerts } = await import('../src/alerts.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');

const post = (id, ts, text) => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="kpszsu/${id}"><div class="tgme_widget_message_text js-message_text" dir="auto"><tg-emoji emoji-id="1"><i class="emoji"><b>🏍</b></i></tg-emoji> ${text}</div><a class="tgme_widget_message_date"><time datetime="${new Date(ts).toISOString()}"></time></a></div></div>`;
let html = '';
let alarm = false;
let apiDown = false;
const fakeFetch = async (url) => {
  if (url.includes('ubilling')) {
    if (apiDown) return { ok: false, status: 500, text: async () => '' };
    return { ok: true, text: async () => JSON.stringify({ states: { 'Дніпропетровська область': { alertnow: alarm } } }) };
  }
  if (url.includes('alerts.com.ua')) return { ok: true, text: async () => JSON.stringify({ states: [{ name: 'Дніпропетровська область', alert: alarm }] }) };
  return { ok: true, text: async () => html };
};

test('разбор публичной страницы канала', () => {
  const now = Date.now();
  const posts = parseChannel(post(10, now, 'Дніпропетровщина: БпЛА курсом на Кривий Ріг.') + post(11, now, 'Житомирщина: БпЛА &amp; ракета'), 'kpszsu');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, 10);
  assert.match(posts[0].text, /^🏍 Дніпропетровщина: БпЛА курсом на Кривий Ріг\.$/);
  assert.equal(posts[1].text.includes('&'), true);
  assert.equal(posts[0].link, 'https://t.me/kpszsu/10');
});

test('состояние тревоги из API с запасным источником', async () => {
  alarm = true;
  assert.equal(await fetchAlertState(fakeFetch), true);
  apiDown = true;
  assert.equal(await fetchAlertState(fakeFetch), true); // второй источник
  apiDown = false;
  alarm = false;
});

test('тревога, где летит и отбой приходят в чаты с включёнными тревогами', async () => {
  _resetAlerts();
  const sent = [];
  app.telegram = { sendMessage: async (id, t) => (sent.push([id, t]), { message_id: sent.length }) };
  app.id = 1;
  const on = chat(-600);
  on.settings.alerts = true;
  const off = chat(-601);
  const t0 = Date.now();
  html = post(1, t0 - 1000, 'Дніпропетровщина: старый пост до запуска');
  await alertsTick(t0, fakeFetch); // baseline: ничего не шлём
  assert.equal(sent.length, 0);

  alarm = true;
  html = post(1, t0 - 1000, 'старый') + post(2, t0 + 60_000, 'Житомирщина: БпЛА курсом на Овруч.') + post(3, t0 + 61_000, 'Дніпропетровщина: БпЛА курсом на Кривий Ріг.');
  await alertsTick(t0 + 61_000, fakeFetch);
  const mine = () => sent.filter((x) => x[0] === -600).map((x) => x[1]);
  assert.equal(sent.some((x) => x[0] === -601), false); // чат без тревог ничего не получает
  assert.match(mine()[0], /ПОВІТРЯНА ТРИВОГА/);
  assert.match(mine()[1], /Кривий Ріг/); // про Дніпропетровщину пересылаем, про Житомирщину нет
  assert.match(mine()[1], /t\.me\/kpszsu\/3/);
  assert.equal(mine().length, 2);

  await alertsTick(t0 + 125_000, fakeFetch); // повторно то же: тишина
  assert.equal(mine().length, 2);

  // про наш город — отдельное срочное сообщение, и лимит на него не действует
  const on2 = chat(-600);
  on2.alertLog = Array(10).fill(t0 + 125_000);
  html += post(4, t0 + 126_000, 'Дніпропетровщина: БпЛА курсом на Кривий Ріг. Укриття!');
  await alertsTick(t0 + 160_000, fakeFetch);
  assert.match(mine().at(-1), /УВАГА! Щось летить на Кривий Ріг/);
  assert.match(mine().at(-1), /Укриття/);
  assert.equal(mine().length, 3);
  on2.alertLog = [];

  alarm = false;
  await alertsTick(t0 + 10 * 60_000 + 5000, fakeFetch);
  assert.match(mine().at(-1), /ВІДБІЙ/);
  assert.match(mine().at(-1), /9 хв/);
  assert.equal(off.settings.alerts, undefined);
});

test('статус по запросу и распознавание вопроса', async () => {
  alarm = false;
  html = post(5, Date.now() - 5 * 60_000, 'Дніпропетровщина: БпЛА курсом на Павлоград.');
  const t = await alertStatusText(fakeFetch);
  assert.match(t, /тривоги немає/);
  assert.match(t, /Павлоград/);
  assert.ok(isAlertQuestion('батя, есть тревога?'));
  assert.ok(isAlertQuestion('где летит?'));
  assert.ok(isAlertQuestion('шо там по відбою?'));
  assert.ok(!isAlertQuestion('ты ракета?'));
  assert.match(startText(), /Дніпропетровській області/);
  assert.match(clearText(95), /1 год 35 хв/);
});
