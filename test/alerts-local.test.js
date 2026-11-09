import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { post, START, mkFetch } from './helpers-alerts.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'al2-'));
process.env.ALERT_CHANNELS = 'kpszsu,oborona_kr';
process.env.ALERT_AREA_CHANNELS = 'oborona_kr';

const { isUrgentPost, alertsTick, _resetAlerts } = await import('../src/alerts.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');

const mock = () => {
  const sent = [];
  app.telegram = { sendMessage: async (id, t) => (sent.push([id, t]), { message_id: sent.length + 500 }), pinChatMessage: async () => true, unpinChatMessage: async () => true, deleteMessage: async () => true };
  app.id = 1;
  return sent;
};

test('«терміново в укриття / коридор» в местном канале — срочное, в чужом без города — нет', async () => {
  assert.equal(isUrgentPost('Терміново в укриття!'), true);
  assert.equal(isUrgentPost('Коридоримся, ховайтесь'), true);
  assert.equal(isUrgentPost('Укриття відкриті на ТЦ'), false);
  assert.equal(isUrgentPost('Криворіжжя локаційно чисто, вибухів немає'), false);

  _resetAlerts();
  const sent = mock();
  const st = chat(-610);
  st.settings.alerts = true;
  const t0 = Date.now();
  let pages = { kpszsu: post('kpszsu', 1, t0 - 1000, 'старый'), oborona_kr: post('oborona_kr', 1, t0 - 1000, 'старый') };
  await alertsTick(t0, mkFetch(pages)); // baseline
  pages = {
    kpszsu: pages.kpszsu + post('kpszsu', 2, t0 + 1000, 'Терміново в укриття всім!'), // федеральный канал: без города не считаем
    oborona_kr: pages.oborona_kr + post('oborona_kr', 2, t0 + 2000, 'Терміново в укриття! Коридоримся!'),
  };
  await alertsTick(t0 + 40_000, mkFetch(pages));
  const mine = sent.filter((x) => x[0] === -610).map((x) => x[1]);
  assert.equal(mine.length, 1);
  assert.match(mine[0], /УВАГА! Щось летить на Кривий Ріг/);
  assert.match(mine[0], /t\.me\/oborona_kr\/2/);
});

test('«чисто / вийшов за межі» пересылаем только пока тревога в городе идёт', async () => {
  _resetAlerts();
  const sent = mock();
  const st = chat(-620);
  st.settings.alerts = true;
  const t0 = Date.now();
  const mine = () => sent.filter((x) => x[0] === -620).map((x) => x[1]);
  let pages = { oborona_kr: post('oborona_kr', 1, t0 - 1000, 'старый') };
  await alertsTick(t0, mkFetch(pages)); // baseline: тревоги нет

  pages = { oborona_kr: pages.oborona_kr + post('oborona_kr', 2, t0 + 1000, 'Криворіжжя локаційно чисто 📡') };
  await alertsTick(t0 + 31_000, mkFetch(pages)); // тревоги нет: «чисто» не нужно
  assert.equal(mine().length, 0);

  pages = { oborona_kr: pages.oborona_kr + post('oborona_kr', 3, t0 + 40_000, START) };
  await alertsTick(t0 + 62_000, mkFetch(pages));
  assert.match(mine()[0], /ТРИВОГА/);
  pages = { oborona_kr: pages.oborona_kr + post('oborona_kr', 4, t0 + 63_000, 'Реактивний вийшов за межі області, без загроз для Кривого Рогу') };
  await alertsTick(t0 + 95_000, mkFetch(pages)); // тревога идёт: это важное обновление
  assert.match(mine().at(-1), /^ℹ️ Реактивний вийшов за межі/);
  assert.doesNotMatch(mine().at(-1), /УВАГА/);
});
