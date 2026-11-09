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

test('закреп всегда актуален: тревога и отбой закрепляются с уведомлением, остаётся только текущее сообщение', async () => {
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
  const sends = () => log.filter((x) => x[0] === 'send');
  let pages = { oborona_kr: post('oborona_kr', 1, t0 - 3_600_000, END), kpszsu: post('kpszsu', 1, t0 - 1000, 'старый') };

  // 1) подключили чат: сразу закрепляется «тревоги нет» (тихо)
  await alertsTick(t0, mkFetch(pages));
  assert.match(sends()[0][2], /ТРИВОГИ НЕМАЄ/);
  const idle = sends()[0][1];
  assert.deepEqual(log.find((x) => x[0] === 'pin'), ['pin', idle, true]); // без звонка
  assert.equal(st.alertStatus.active, false);

  // 2) тревога: новое сообщение закреплено С уведомлением, старый статус откреплён и удалён
  log.length = 0;
  pages = { oborona_kr: pages.oborona_kr + post('oborona_kr', 2, t0 + 1000, START), kpszsu: pages.kpszsu + post('kpszsu', 2, t0 + 2000, 'Реактивні БпЛА на Кривий Ріг з півдня!') };
  await alertsTick(t0 + 31_000, mkFetch(pages));
  const alarmMsg = sends()[0];
  assert.match(alarmMsg[2], /ПОВІТРЯНА ТРИВОГА/);
  assert.ok(log.some((x) => x[0] === 'unpin' && x[1] === idle));
  assert.ok(log.some((x) => x[0] === 'del' && x[1] === idle));
  assert.deepEqual(log.find((x) => x[0] === 'pin'), ['pin', alarmMsg[1], false]); // закреплено С уведомлением
  assert.match(sends()[1][2], /Кривий Ріг/); // «летит»
  assert.equal(st.alertStatus.active, true);
  const flightId = sends()[1][1];

  // 3) отбой: удалены тревога и «летит», остаётся только отбой, он закреплён с уведомлением и остаётся закреплённым
  log.length = 0;
  pages = { ...pages, oborona_kr: pages.oborona_kr + post('oborona_kr', 3, t0 + 20 * 60_000 - 5000, END) };
  await alertsTick(t0 + 20 * 60_000, mkFetch(pages));
  const dels = log.filter((x) => x[0] === 'del').map((x) => x[1]);
  assert.deepEqual(dels.sort(), [alarmMsg[1], flightId].sort());
  assert.ok(log.some((x) => x[0] === 'unpin' && x[1] === alarmMsg[1]));
  const clearMsg = sends().at(-1);
  assert.match(clearMsg[2], /ВІДБІЙ/);
  assert.ok(log.some((x) => x[0] === 'pin' && x[1] === clearMsg[1] && x[2] === false));
  assert.equal(st.history.some((m) => [alarmMsg[1], flightId].includes(m.id)), false);
  assert.equal(st.alertStatus.active, false);

  // 4) отбой НЕ откреплается сам: в закрепе всегда актуальное состояние
  log.length = 0;
  await alertsTick(t0 + 3 * 3600_000, mkFetch(pages));
  assert.equal(log.length, 0);

  // 5) новая тревога убирает старый отбой
  pages = { ...pages, oborona_kr: pages.oborona_kr + post('oborona_kr', 4, t0 + 3 * 3600_000 + 40_000, START) };
  await alertsTick(t0 + 3 * 3600_000 + 60_000, mkFetch(pages));
  assert.ok(log.some((x) => x[0] === 'del' && x[1] === clearMsg[1]));
  assert.match(sends().at(-1)[2], /ПОВІТРЯНА ТРИВОГА/);
});

test('чат подключили во время тревоги: сразу закрепляется тревога с уведомлением', async () => {
  _resetAlerts();
  const log = [];
  let n = 300;
  app.telegram = {
    sendMessage: async (id, t) => (log.push(['send', ++n, t]), { message_id: n }),
    pinChatMessage: async (id, mid, o) => log.push(['pin', mid, o.disable_notification]),
    unpinChatMessage: async () => true,
    deleteMessage: async () => true,
  };
  const st = chat(-702);
  st.settings.alerts = true;
  const t0 = Date.now();
  const pages = { oborona_kr: post('oborona_kr', 1, t0 - 40 * 60_000, END) + post('oborona_kr', 2, t0 - 30 * 60_000, START) }; // тревога идёт уже полчаса
  await alertsTick(t0, mkFetch(pages));
  const mine = log.filter((x) => x[0] === 'send');
  assert.match(mine[0][2], /ПОВІТРЯНА ТРИВОГА/);
  assert.deepEqual(log.find((x) => x[0] === 'pin'), ['pin', mine[0][1], false]);
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

test('устаревшие «летит» убираются по сроку жизни, закреплённый статус остаётся', async () => {
  for (const id of [-700, -701, -702]) chat(id).settings.alerts = false; // чаты прошлых тестов не мешают
  _resetAlerts();
  const log = [];
  let n = 400;
  app.telegram = {
    sendMessage: async (id, t) => (log.push(['send', ++n, t]), { message_id: n }),
    pinChatMessage: async () => true,
    unpinChatMessage: async () => true,
    deleteMessage: async (id, mid) => log.push(['del', mid]),
  };
  const st = chat(-703);
  st.settings.alerts = true;
  const t0 = Date.now();
  let pages = { oborona_kr: post('oborona_kr', 1, t0 - 1000, END), kpszsu: post('kpszsu', 1, t0 - 1000, 'старый') };
  await alertsTick(t0, mkFetch(pages));
  pages = { oborona_kr: pages.oborona_kr + post('oborona_kr', 2, t0 + 1000, START), kpszsu: pages.kpszsu + post('kpszsu', 2, t0 + 2000, 'Дніпропетровщина: БпЛА курсом на Кривий Ріг.') + post('kpszsu', 3, t0 + 2500, 'Реактивний вийшов за межі області, без загроз для Кривого Рогу') };
  await alertsTick(t0 + 31_000, mkFetch(pages));
  const sends = log.filter((x) => x[0] === 'send');
  const status = sends.find((x) => /ПОВІТРЯНА ТРИВОГА/.test(x[2]))[1];
  const drone = sends.find((x) => /РУХ ПОБЛИЗУ/.test(x[2]))[1];
  const update = sends.find((x) => /ОНОВЛЕННЯ/.test(x[2]))[1];

  log.length = 0;
  await alertsTick(t0 + 16 * 60_000, mkFetch(pages)); // 16 минут: обновление «ℹ️» уже неактуально, БпЛА ещё живёт
  assert.deepEqual(log.filter((x) => x[0] === 'del').map((x) => x[1]), [update]);

  log.length = 0;
  await alertsTick(t0 + 32 * 60_000, mkFetch(pages)); // 32 минуты: убрано и «БпЛА», хотя тревога ещё идёт
  assert.deepEqual(log.filter((x) => x[0] === 'del').map((x) => x[1]), [drone]);
  assert.equal(st.alertStatus.id, status); // закреплённая тревога остаётся
});
