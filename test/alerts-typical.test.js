import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { post, START, END, mkFetch } from './helpers-alerts.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'al3-'));
process.env.ALERT_CHANNELS = 'typical_KR'; // местный канал по умолчанию считается «местным»

const { isUrgentPost, alertsTick, _resetAlerts } = await import('../src/alerts.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');

const mock = () => {
  const sent = [];
  app.telegram = { sendMessage: async (id, t, o) => (sent.push([id, t, o]), { message_id: sent.length + 500 }), pinChatMessage: async () => true, unpinChatMessage: async () => true, deleteMessage: async () => true };
  app.id = 1;
  return sent;
};

test('typical_KR: «ГУЧНО! Працює ППО» — срочно, «може бути гучно» и новости — нет, подписи вырезаются', async () => {
  const { parseChannel } = await import('../src/alerts.js');
  const posts = parseChannel(post('typical_KR', 9, Date.now(), '❗️ГУЧНО! Працює ППО.<br/><br/>Повідомити про подію ◀️<br/>ПІДПИСАТИСЬ 👇'), 'typical_KR');
  assert.equal(posts[0].text, '❗️ГУЧНО! Працює ППО.');
  assert.equal(isUrgentPost('❗️ГУЧНО! Працює ППО.'), true);
  assert.equal(isUrgentPost('▫️ Мопед летить транзитом повз Даманський\n\nМоже бути гучно.'), false);
  assert.equal(isUrgentPost('💡ОНОВЛЕНИЙ ГРАФІК НА СЬОГОДНІ — публікує ДТЕК.'), false);

  // без тревоги и без подтверждения одно «ГУЧНО! Працює ППО» не публикуем
  _resetAlerts();
  let sent = mock();
  let st = chat(-630);
  st.settings.alerts = true;
  st.alertStatus = { id: 1, active: false, at: 0 };
  const t0 = Date.now();
  let pages = { typical_KR: post('typical_KR', 1, t0 - 1000, 'старый'), oborona_kr: post('oborona_kr', 1, t0 - 1000, END) };
  await alertsTick(t0, mkFetch(pages));
  const feed = (n) => ({
    typical_KR: pages.typical_KR
      + post('typical_KR', 2 + n, t0 + 1000, '👑 Король картоплі вийшов на зв\'язок та показав, як треба рубати дрова')
      + post('typical_KR', 3 + n, t0 + 2000, '💡ОНОВЛЕНИЙ ГРАФІК НА СЬОГОДНІ — публікує ДТЕК.')
      + post('typical_KR', 4 + n, t0 + 3000, '❗️ГУЧНО! Працює ППО.<br/>Повідомити про подію ◀️<br/>ПІДПИСАТИСЬ 👇'),
    oborona_kr: pages.oborona_kr,
  });
  await alertsTick(t0 + 11_000, mkFetch(feed(0)));
  assert.equal(sent.filter((x) => x[0] === -630).length, 0); // новости, график ДТЕК и «ГУЧНО» без тревоги не пересылаются

  // во время тревоги в городе то же «ГУЧНО» — срочно
  _resetAlerts();
  sent = mock();
  st = chat(-631);
  chat(-630).settings.alerts = false;
  st.settings.alerts = true;
  st.alertStatus = { id: 1, active: false, at: 0 };
  pages = { typical_KR: post('typical_KR', 1, t0 - 1000, 'старый'), oborona_kr: post('oborona_kr', 1, t0 - 1000, END) };
  await alertsTick(t0, mkFetch(pages));
  const withAlarm = feed(10);
  withAlarm.oborona_kr = pages.oborona_kr + post('oborona_kr', 2, t0 + 500, START);
  await alertsTick(t0 + 11_000, mkFetch(withAlarm));
  const mine = sent.filter((x) => x[0] === -631).map((x) => x[1]);
  assert.ok(mine.some((t) => /^🚨 ПОВІТРЯНА ТРИВОГА/.test(t)));
  assert.ok(mine.some((t) => /^🚨 УВАГА\n📍 Кривий Ріг\n❗️ГУЧНО! Працює ППО\./.test(t)));
  assert.equal(mine.length, 2);
});
