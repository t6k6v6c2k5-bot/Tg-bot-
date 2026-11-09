import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { post, mkFetch } from './helpers-alerts.js';

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

  _resetAlerts();
  const sent = mock();
  const st = chat(-630);
  st.settings.alerts = true;
  st.alertStatus = { id: 1, active: false, at: 0 };
  const t0 = Date.now();
  let pages = { typical_KR: post('typical_KR', 1, t0 - 1000, 'старый') };
  await alertsTick(t0, mkFetch(pages));
  pages = {
    typical_KR: pages.typical_KR
      + post('typical_KR', 2, t0 + 1000, '👑 Король картоплі вийшов на зв\'язок та показав, як треба рубати дрова')
      + post('typical_KR', 3, t0 + 2000, '💡ОНОВЛЕНИЙ ГРАФІК НА СЬОГОДНІ — публікує ДТЕК.')
      + post('typical_KR', 4, t0 + 3000, '❗️ГУЧНО! Працює ППО.<br/>Повідомити про подію ◀️<br/>ПІДПИСАТИСЬ 👇'),
  };
  await alertsTick(t0 + 31_000, mkFetch(pages));
  const mine = sent.filter((x) => x[0] === -630).map((x) => x[1]);
  assert.equal(mine.length, 1); // новости и график ДТЕК не пересылаются
  assert.match(mine[0], /^🚨 УВАГА\n📍 Кривий Ріг\n❗️ГУЧНО! Працює ППО\./);
});
