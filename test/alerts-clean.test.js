import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { post, START, END, mkFetch } from './helpers-alerts.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alc-'));
process.env.ALERT_CHANNELS = 'kpszsu,oborona_kr';
process.env.ALERT_AREA_CHANNELS = 'oborona_kr';

const { alertsTick, _resetAlerts } = await import('../src/alerts.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');

test('отбой: всё про тревогу удаляется, остаётся только отбой; тревога и отбой закрепляются, отбой снимается через 15 минут', async () => {
  _resetAlerts();
  const log = [];
  let n = 100;
  app.telegram = {
    sendMessage: async (id, t) => (log.push(['send', ++n, t]), { message_id: n }),
    pinChatMessage: async (id, mid, o) => log.push(['pin', mid, o.disable_notification]),
    unpinChatMessage: async (id, mid) => log.push(['unpin', mid]),
    deleteMessage: async (id, mid) => log.push(['del', mid]),
  };
  app.id = 1;
  const st = chat(-700);
  st.settings.alerts = true;
  const t0 = Date.now();
  let pages = { oborona_kr: post('oborona_kr', 1, t0 - 1000, END), kpszsu: post('kpszsu', 1, t0 - 1000, 'старый') };
  await alertsTick(t0, mkFetch(pages)); // baseline
  pages = { oborona_kr: pages.oborona_kr + post('oborona_kr', 2, t0 + 1000, START), kpszsu: pages.kpszsu + post('kpszsu', 2, t0 + 2000, 'Реактивні БпЛА на Кривий Ріг з півдня!') };
  await alertsTick(t0 + 31_000, mkFetch(pages));
  const sends = () => log.filter((x) => x[0] === 'send');
  assert.match(sends()[0][2], /ПОВІТРЯНА ТРИВОГА/);
  assert.deepEqual(log.find((x) => x[0] === 'pin'), ['pin', sends()[0][1], false]); // закреплено С уведомлением
  assert.match(sends()[1][2], /Кривий Ріг/);
  const ids = [sends()[0][1], sends()[1][1]];

  log.length = 0;
  pages = { ...pages, oborona_kr: pages.oborona_kr + post('oborona_kr', 3, t0 + 20 * 60_000 - 5000, END) };
  await alertsTick(t0 + 20 * 60_000, mkFetch(pages));
  const dels = log.filter((x) => x[0] === 'del').map((x) => x[1]);
  assert.deepEqual(dels.sort(), ids.sort()); // удалены и тревога, и «летит»
  assert.ok(log.some((x) => x[0] === 'unpin' && x[1] === ids[0])); // тревога откреплена
  const clearMsg = sends().at(-1);
  assert.match(clearMsg[2], /ВІДБІЙ/);
  assert.match(clearMsg[2], /19 хв|20 хв/);
  assert.ok(log.some((x) => x[0] === 'pin' && x[1] === clearMsg[1] && x[2] === false)); // отбой закреплён с уведомлением
  assert.equal(st.history.some((m) => ids.includes(m.id)), false); // и из истории убрано

  log.length = 0;
  await alertsTick(t0 + 20 * 60_000 + 16 * 60_000, mkFetch(pages)); // через 15 минут снимаем закреп с отбоя
  assert.ok(log.some((x) => x[0] === 'unpin' && x[1] === clearMsg[1]));
  assert.equal(log.some((x) => x[0] === 'del'), false); // сам отбой остаётся
});

test('нет прав админа: тревога всё равно приходит, ошибки закрепления не ломают рассылку', async () => {
  _resetAlerts();
  const sent = [];
  app.telegram = {
    sendMessage: async (id, t) => (sent.push(t), { message_id: sent.length }),
    pinChatMessage: async () => { throw new Error('not enough rights'); },
    unpinChatMessage: async () => { throw new Error('not enough rights'); },
    deleteMessage: async () => { throw new Error('not enough rights'); },
  };
  const st = chat(-701);
  st.settings.alerts = true;
  const t0 = Date.now();
  let pages = { oborona_kr: post('oborona_kr', 1, t0 - 1000, END) };
  await alertsTick(t0, mkFetch(pages));
  pages = { oborona_kr: pages.oborona_kr + post('oborona_kr', 2, t0 + 1000, START) };
  await alertsTick(t0 + 31_000, mkFetch(pages));
  pages = { oborona_kr: pages.oborona_kr + post('oborona_kr', 3, t0 + 40_000, END) };
  await alertsTick(t0 + 62_000, mkFetch(pages));
  assert.ok(sent.some((t) => /ТРИВОГА/.test(t)));
  assert.ok(sent.some((t) => /ВІДБІЙ/.test(t)));
});
