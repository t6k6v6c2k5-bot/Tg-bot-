import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { post, START, END, mkFetch } from './helpers-alerts.js';

process.env.ALERT_FAST_ONLY = '0'; // эти тесты проверяют все виды сообщений
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-'));
process.env.ALERT_CHANNELS = 'kpszsu,oborona_kr';
process.env.ALERT_AREA_CHANNELS = 'oborona_kr';

const { isMissileThreat, fastTitle, alertsTick, _resetAlerts } = await import('../src/alerts.js');
const { config } = await import('../src/config.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');

const ours = (t) => new RegExp(config.alertPriority.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i').test(t);

test('наши края: город, районы, Апостолове, Зеленодольськ, Софіївка, Даманський и сёла района; чужие города нет', () => {
  for (const t of ['БпЛА курсом на Апостолове', 'Курс на Зеленодольськ', 'Дрони на Софіївку', 'Мопед на Даманський', 'Гданцівка', 'Лозуватка', 'Інгулецький район', 'Тернуватий Кут', 'Мудрьона', 'у районі 95 кварталу', 'Новолатівка', 'Широківська громада', 'Саксаганський район']) assert.ok(ours(t), t);
  for (const t of ['Курсом на Дніпро', 'БпЛА на Павлоград, Нікополь', 'Покровськ', 'Широке повітря', 'Степне', 'Запоріжжя', 'Жовті Води']) assert.ok(!ours(t), t);
});

test('бандероль и КАБ — быстрые угрозы, как ракеты; транзит без красного уровня — нет', () => {
  assert.equal(isMissileThreat('Бандероль на Кривий Ріг!'), true);
  assert.equal(isMissileThreat('Бандероль курсом на Апостолове'), true);
  assert.equal(isMissileThreat('КАБи на Зеленодольськ'), true);
  assert.equal(isMissileThreat('Пуск КАБ у напрямку Кривого Рогу'), true);
  assert.equal(isMissileThreat('Керована авіабомба на Криворіжжя'), true);
  assert.equal(isMissileThreat('Каблучка'), false); // слово «каб…» внутри другого слова
  assert.equal(isMissileThreat('Кабінет міністрів: ракета на Кривий Ріг'), true); // ракета, а не «кабінет»
  assert.equal(isMissileThreat('Бандероль транзитом повз Кривий Ріг на захід'), false);
  assert.equal(isMissileThreat('Бандероль на Нікополь'), false);
  assert.equal(fastTitle('КАБи на Зеленодольськ'), '💣 КАБ');
  assert.equal(fastTitle('Бандероль на Кривий Ріг'), '🚀 БАНДЕРОЛЬ');
  assert.equal(fastTitle('Балістика на Кривий Ріг'), '🚀 РАКЕТНА ЗАГРОЗА');
});

test('срочная карточка по бандероли на Апостолове и быстрый опрос каналов', async () => {
  _resetAlerts();
  const sent = [];
  app.telegram = { sendMessage: async (id, t) => (sent.push([id, t]), { message_id: sent.length }), pinChatMessage: async () => true, unpinChatMessage: async () => true, deleteMessage: async () => true };
  const st = chat(-640);
  st.settings.alerts = true;
  st.alertStatus = { id: 1, active: false, at: 0 };
  const t0 = Date.now();
  let p = { kpszsu: post('kpszsu', 1, t0 - 1000, 'старый'), oborona_kr: post('oborona_kr', 1, t0 - 1000, END) };
  await alertsTick(t0, mkFetch(p));
  p = { ...p, kpszsu: p.kpszsu + post('kpszsu', 2, t0 + 500, 'Бандероль курсом на Апостолове!') };
  await alertsTick(t0 + 11_000, mkFetch(p)); // через 11 секунд: опрос теперь раз в 10 с
  const mine = sent.filter((x) => x[0] === -640).map((x) => x[1]);
  assert.equal(mine.length, 1);
  assert.match(mine[0], /^🚀 БАНДЕРОЛЬ\n📍 Кривий Ріг\n‼️ Терміново в укриття!\nБандероль курсом на Апостолове!/);
});

test('сборы денег и реклама не публикуются', async () => {
  const { isThreatPost, isNoise } = await import('../src/alerts.js');
  const fundraiser = '🫡🫡 на тепловізори та обладнання для захисників неба Криворіжжя👀\n\n💁‍♀️Друзі, до нас звернулись хлопці які безпосередньо працюють по цілям над Кривбасом. Для ефективної роботи їм необхідні ще два тепловізори та ще деякі ніштячки\n\n🤝Ми можемо полегшити нашим тіграм виявлення ворожих цілей\n\nТвій сППОкій у твоєму гаманці твоїх руках✌️\n\n⛳️Ціль збору: 250 000 грн\n\n🫙Банка🔽\nhttps://send.monobank.ua/jar/6zfGJnX8cL\n\n🏦Карта🔽\n4874 1000 3417 5680';
  assert.equal(isNoise(fundraiser), true);
  assert.equal(isThreatPost(fundraiser), false);
  assert.equal(isNoise('Збір на дрони: картка 4874 1000 3417 5680'), true);
  assert.equal(isNoise('Дніпропетровщина: БпЛА курсом на Кривий Ріг.'), false);
  assert.equal(isNoise('Реактивний вийшов за межі області'), false);

  _resetAlerts();
  const sent = [];
  app.telegram = { sendMessage: async (id, t) => (sent.push([id, t]), { message_id: sent.length }), pinChatMessage: async () => true, unpinChatMessage: async () => true, deleteMessage: async () => true };
  const st = chat(-641);
  st.settings.alerts = true;
  st.alertStatus = { id: 1, active: false, at: 0 };
  const t0 = Date.now();
  let p = { oborona_kr: post('oborona_kr', 1, t0 - 1000, END) };
  await alertsTick(t0, mkFetch(p));
  p = { oborona_kr: p.oborona_kr + post('oborona_kr', 2, t0 + 500, fundraiser.replace(/\n/g, '<br/>')) };
  await alertsTick(t0 + 11_000, mkFetch(p));
  assert.equal(sent.filter((x) => x[0] === -641).length, 0);
});

test('одно «Гучно.» без тревоги и подтверждения — молчим; в тревогу или с подтверждением — пишем; рассказ о последствиях — нет', async () => {
  const { isLoudOnly, isNoise, isThreatPost } = await import('../src/alerts.js');
  assert.equal(isLoudOnly('Гучно.🤯'), true);
  assert.equal(isLoudOnly('Вибух у місті. Гучно'), false); // «вибух» — само по себе
  const after = 'Ворог завдав удару БпЛА "Бандероль" по об\'єкту інфраструктури в північній частині міста.\nПопередньо – без постраждалих';
  assert.equal(isNoise(after), true);
  assert.equal(isThreatPost(after), false);
  assert.equal(isMissileThreat(after), false);

  const mkChat = (id) => {
    const st = chat(id);
    st.settings.alerts = true;
    st.alertStatus = { id: 1, active: false, at: 0 };
    return st;
  };
  const run = async (id, pagesAfter, apiAreaStart = false) => {
    _resetAlerts();
    const sent = [];
    app.telegram = { sendMessage: async (cid, t) => (sent.push([cid, t]), { message_id: sent.length }), pinChatMessage: async () => true, unpinChatMessage: async () => true, deleteMessage: async () => true };
    mkChat(id);
    for (const other of [-640, -641, -642, -643, -644]) if (other !== id) chat(other).settings.alerts = false;
    const t0 = Date.now();
    const base = { kpszsu: post('kpszsu', 1, t0 - 1000, 'старый'), oborona_kr: post('oborona_kr', 1, t0 - 1000, END), typical_KR: post('typical_KR', 1, t0 - 1000, 'старый') };
    await alertsTick(t0, mkFetch(base));
    const next = pagesAfter(t0, base);
    await alertsTick(t0 + 11_000, mkFetch(next));
    return sent.filter((x) => x[0] === id).map((x) => x[1]);
  };
  // 1) одно «Гучно.», тревоги нет, больше никто не пишет
  let got = await run(-642, (t0, b) => ({ ...b, oborona_kr: b.oborona_kr + post('oborona_kr', 2, t0 + 500, 'Гучно.🤯') }));
  assert.equal(got.length, 0);
  // 2) рассказ о последствиях
  got = await run(-643, (t0, b) => ({ ...b, typical_KR: b.typical_KR + post('typical_KR', 2, t0 + 500, 'Ворог завдав удару БпЛА "Бандероль" по об\'єкту інфраструктури в північній частині міста.<br/>Попередньо – без постраждалих') }));
  assert.equal(got.length, 0);
});
