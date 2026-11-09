import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { post, START, END, mkFetch } from './helpers-alerts.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-'));
process.env.ALERT_CHANNELS = 'kpszsu,oborona_kr';
process.env.ALERT_AREA_CHANNELS = 'oborona_kr';
delete process.env.ALERT_FAST_ONLY; // по умолчанию: только КАБ, бандероль, ракеты

const { alertsTick, _resetAlerts } = await import('../src/alerts.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');

test('по умолчанию пишем только про КАБы, бандероли и ракеты; БпЛА, обновления и «гучно» — нет', async () => {
  _resetAlerts();
  const sent = [];
  app.telegram = { sendMessage: async (id, t) => (sent.push([id, t]), { message_id: sent.length }), pinChatMessage: async () => true, unpinChatMessage: async () => true, deleteMessage: async () => true };
  const st = chat(-730);
  for (const id of [-640, -641, -642, -643, -644, -605, -602, -603, -604]) if (chat(id)) chat(id).settings.alerts = false;
  st.settings.alerts = true;
  st.alertStatus = { id: 1, active: false, at: 0 };
  const t0 = Date.now();
  let p = { kpszsu: post('kpszsu', 1, t0 - 1000, 'старый'), oborona_kr: post('oborona_kr', 1, t0 - 1000, END) };
  await alertsTick(t0, mkFetch(p));
  // тревога объявлена: движение БпЛА, обновление и «гучно» — не пересылаем
  p = {
    kpszsu: p.kpszsu + post('kpszsu', 2, t0 + 500, 'Дніпропетровщина: БпЛА курсом на Кривий Ріг.') + post('kpszsu', 3, t0 + 600, 'Реактивний вийшов за межі області, без загроз для Кривого Рогу'),
    oborona_kr: p.oborona_kr + post('oborona_kr', 2, t0 + 400, START) + post('oborona_kr', 3, t0 + 700, 'Терміново в укриття! Гучно'),
  };
  await alertsTick(t0 + 11_000, mkFetch(p));
  let mine = sent.filter((x) => x[0] === -730).map((x) => x[1]);
  assert.equal(mine.length, 1);
  assert.match(mine[0], /^🚨 ПОВІТРЯНА ТРИВОГА/); // только сама тревога (с причиной)

  // быстрые угрозы пишем
  p = {
    kpszsu: p.kpszsu + post('kpszsu', 4, t0 + 20_000, 'Бандероль курсом на Кривий Ріг!') + post('kpszsu', 5, t0 + 21_000, 'Пуск КАБ у напрямку Апостолового') + post('kpszsu', 6, t0 + 22_000, 'Балістика на Дніпропетровщину'),
    oborona_kr: p.oborona_kr,
  };
  await alertsTick(t0 + 32_000, mkFetch(p));
  mine = sent.filter((x) => x[0] === -730).map((x) => x[1]).slice(1);
  assert.equal(mine.length, 3);
  assert.match(mine[0], /^🚀 БАНДЕРОЛЬ/);
  assert.match(mine[1], /^💣 КАБ/);
  assert.match(mine[2], /^🚀 РАКЕТНА ЗАГРОЗА/);
});
