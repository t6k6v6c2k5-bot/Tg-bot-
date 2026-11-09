import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { post, START, END, mkFetch } from './helpers-alerts.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'al-'));
process.env.ALERT_CHANNELS = 'kpszsu,oborona_kr';
process.env.ALERT_AREA_CHANNELS = 'oborona_kr';

const { parseChannel, cleanPost, isDirectThreat, areaEvent, alertsTick, alertStatusText, isAlertQuestion, isThreatPost, similar, startText, clearText, _resetAlerts } = await import('../src/alerts.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');

test('разбор страницы канала, подписи каналов вырезаются', () => {
  const now = Date.now();
  const html = post('dnipro_alerts', 7, now, 'Кривий Ріг жовтогарячий 🟧. Попередньо транзит на захід реактивного.<br/><br/>ℹ️ Alerts Live • 🤙 Зворотний зв’язок') + post('kpszsu', 8, now, '<tg-emoji emoji-id="1"><i class="emoji"><b>🏍</b></i></tg-emoji> Житомирщина: БпЛА &amp; ракета');
  const posts = parseChannel(html, 'x');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].text, 'Кривий Ріг жовтогарячий 🟧. Попередньо транзит на захід реактивного.'); // без «Alerts Live…»
  assert.equal(posts[0].link, 'https://t.me/dnipro_alerts/7');
  assert.equal(posts[1].text, '🏍 Житомирщина: БпЛА & ракета');
  assert.equal(cleanPost('Все, далі в глиб Кіровоградщини\n\nКриворіжжя локаційно чисто 📡\n\n✉️chatbot|💬𝟏𝐌𝐒_𝐊𝐑™|💬Treads'), 'Все, далі в глиб Кіровоградщини\n\nКриворіжжя локаційно чисто 📡');
});

test('тревога именно по Криворізькому району: старт и отбой', () => {
  assert.equal(areaEvent(START), 'start');
  assert.equal(areaEvent(END), 'end');
  assert.equal(areaEvent('🔴 Дніпропетровська область — повітряна тривога'), null); // вся область — не наш район
  assert.equal(areaEvent('🔴 Нікопольський район — повітряна тривога'), null);
  assert.equal(areaEvent('Кривий Ріг: БпЛА курсом на місто'), null);
});

test('тревога по району объявляется, область не важна; отбой тоже', async () => {
  _resetAlerts();
  const sent = [];
  app.telegram = { sendMessage: async (id, t, o) => (sent.push([id, t, o]), { message_id: sent.length }), pinChatMessage: async () => true, unpinChatMessage: async () => true, deleteMessage: async () => true };
  app.id = 1;
  const on = chat(-600);
  on.settings.alerts = true;
  on.alertStatus = { id: 1, active: false, at: 0 }; // закреп уже есть: тест про другое
  const off = chat(-601);
  const t0 = Date.now();
  let pages = { oborona_kr: post('oborona_kr', 1, t0 - 3_600_000, END) };
  await alertsTick(t0, mkFetch(pages, true)); // baseline: область в тревоге (API), но по району отбой: молчим
  assert.equal(sent.length, 0);

  pages = { oborona_kr: pages.oborona_kr + post('oborona_kr', 2, t0 + 5_000, START) };
  await alertsTick(t0 + 31_000, mkFetch(pages));
  const mine = () => sent.filter((x) => x[0] === -600).map((x) => x[1]);
  assert.equal(sent.some((x) => x[0] === -601), false); // чат без тревог ничего не получает
  assert.match(mine()[0], /ПОВІТРЯНА ТРИВОГА у Кривому Розі/);
  assert.doesNotMatch(mine()[0], /област/i);

  await alertsTick(t0 + 62_000, mkFetch(pages)); // тот же пост — тишина
  assert.equal(mine().length, 1);

  pages = { oborona_kr: pages.oborona_kr + post('oborona_kr', 3, t0 + 70_000, END) };
  await alertsTick(t0 + 93_000, mkFetch(pages));
  assert.match(mine().at(-1), /ВІДБІЙ повітряної тривоги у Кривому Розі/);
  assert.equal(off.settings.alerts, undefined);
});

test('где летит: про город срочно, ссылки без превью-карточки, подписи каналов убраны', async () => {
  _resetAlerts();
  const sent = [];
  app.telegram = { sendMessage: async (id, t, o) => (sent.push([id, t, o]), { message_id: sent.length }), pinChatMessage: async () => true, unpinChatMessage: async () => true, deleteMessage: async () => true };
  const st = chat(-602);
  st.settings.alerts = true;
  st.alertStatus = { id: 1, active: false, at: 0 }; // закреп уже есть: тест про другое
  const t0 = Date.now();
  let pages = { kpszsu: post('kpszsu', 1, t0 - 1000, 'старый') };
  await alertsTick(t0, mkFetch(pages)); // baseline
  pages = { kpszsu: pages.kpszsu + post('kpszsu', 2, t0 + 1000, 'Житомирщина: БпЛА курсом на Овруч.') + post('kpszsu', 3, t0 + 2000, 'Дніпропетровщина: БпЛА курсом на Кривий Ріг.<br/>ℹ️ Alerts Live • Зворотний зв’язок') };
  await alertsTick(t0 + 31_000, mkFetch(pages));
  const mine = sent.filter((x) => x[0] === -602);
  assert.equal(mine.length, 1);
  assert.match(mine[0][1], /УВАГА! Щось летить на Кривий Ріг/);
  assert.doesNotMatch(mine[0][1], /Alerts Live/);
  assert.match(mine[0][1], /Джерело: https:\/\/t\.me\/kpszsu\/3/);
  assert.deepEqual(mine[0][2].link_preview_options, { is_disabled: true });
});

test('статус: по городу, а не по области', async () => {
  const t0 = Date.now();
  let pages = { oborona_kr: post('oborona_kr', 5, t0 - 60_000, START), kpszsu: post('kpszsu', 9, t0 - 5 * 60_000, 'Дніпропетровщина: БпЛА курсом на Павлоград.') };
  let t = await alertStatusText(mkFetch(pages, false)); // область говорит «нет», район — тревога
  assert.match(t, /У Кривому Розі зараз ПОВІТРЯНА ТРИВОГА/);
  assert.doesNotMatch(t, /Дніпропетровськ/);
  assert.match(t, /Павлоград/);
  pages = { oborona_kr: post('oborona_kr', 6, t0 - 60_000, END) };
  t = await alertStatusText(mkFetch(pages, true));
  assert.match(t, /У Кривому Розі зараз тривоги немає/);
  t = await alertStatusText(mkFetch({}, true)); // по городу данных нет: честно говорим
  assert.match(t, /По Кривому Розі даних зараз немає/);
});

test('распознавание вопроса и фильтры', () => {
  assert.ok(isAlertQuestion('батя, есть тревога?'));
  assert.ok(isAlertQuestion('где летит?'));
  assert.ok(isAlertQuestion('шо там по відбою?'));
  assert.ok(!isAlertQuestion('ты ракета?'));
  assert.equal(isThreatPost('Криворіжжя локаційно чисто 📡'), false);
  assert.equal(isThreatPost('БпЛА курсом на Кривий Ріг'), true);
  assert.equal(similar('Дніпропетровщина: БпЛА курсом на Кривий Ріг', 'БпЛА курсом на Кривий Ріг із заходу'), true);
  assert.equal(similar('БпЛА курсом на Кривий Ріг', 'Реактивний від Солоного на захід'), false);
  assert.match(startText(), /у Кривому Розі/);
  assert.doesNotMatch(startText(), /укритт/); // не пугаем: сирена сама по себе не значит прямую угрозу
  assert.match(clearText(95), /1 год 35 хв/);
});

test('прямая угроза и движение рядом различаются: «транзит» не кричит УВАГА', async () => {
  assert.equal(isDirectThreat('Дніпропетровщина: БпЛА курсом на Кривий Ріг.'), true);
  assert.equal(isDirectThreat('Реактивні БпЛА на Кривий Ріг з півдня!'), true);
  assert.equal(isDirectThreat('Вибух у Кривому Розі'), true);
  assert.equal(isDirectThreat('Кривий Ріг червоний рівень, курс на місто'), true);
  assert.equal(isDirectThreat('Рух реактивного в напрямку північної частини Кривого Рогу. Попередньо транзит на захід. Решта області жовтий 🟨.'), false);
  assert.equal(isDirectThreat('Кривий Ріг жовтогарячий 🟧. Попередньо транзит на захід реактивного північною частиною міста.'), false);

  _resetAlerts();
  const sent = [];
  app.telegram = { sendMessage: async (id, t) => (sent.push([id, t]), { message_id: sent.length }), pinChatMessage: async () => true, unpinChatMessage: async () => true, deleteMessage: async () => true };
  const st = chat(-603);
  st.settings.alerts = true;
  st.alertStatus = { id: 1, active: false, at: 0 };
  const t0 = Date.now();
  let pages = { kpszsu: post('kpszsu', 1, t0 - 1000, 'старый') };
  await alertsTick(t0, mkFetch(pages));
  pages = { kpszsu: pages.kpszsu + post('kpszsu', 2, t0 + 1000, 'Рух реактивного в напрямку північної частини Кривого Рогу. Попередньо транзит на захід. Решта області жовтий 🟨.') };
  await alertsTick(t0 + 31_000, mkFetch(pages));
  const mine = sent.filter((x) => x[0] === -603).map((x) => x[1]);
  assert.equal(mine.length, 1);
  assert.match(mine[0], /^🛩 Рух реактивного/); // обычное сообщение, не «УВАГА»
  assert.doesNotMatch(mine[0], /УВАГА/);
});
