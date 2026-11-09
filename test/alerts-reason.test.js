import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { post, reply, START, END, mkFetch } from './helpers-alerts.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsn-'));
process.env.ALERT_CHANNELS = 'oborona_kr,kpszsu';
process.env.ALERT_AREA_CHANNELS = 'oborona_kr';

const { parseChannel, alertsTick, _resetAlerts } = await import('../src/alerts.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');

test('в посте-ответе текст берётся от самого поста, а не от цитаты', () => {
  const html = reply('oborona_kr', 20, Date.now(), 'Шахедна<br/>По реактивному зі сходу', 19, START);
  const p = parseChannel(html, 'oborona_kr')[0];
  assert.equal(p.text, 'Шахедна\nПо реактивному зі сходу');
  assert.equal(p.replyTo, 19);
});

test('ответ на пост о тревоге дописывается в причину закреплённого сообщения', async () => {
  _resetAlerts();
  const log = [];
  let n = 900;
  app.telegram = {
    sendMessage: async (id, t) => (id === -720 && log.push(['send', n + 1, t]), { message_id: ++n }),
    pinChatMessage: async () => true,
    unpinChatMessage: async () => true,
    deleteMessage: async () => true,
    editMessageText: async (id, mid, inl, text, extra) => id === -720 && log.push(['edit', mid, text, extra]),
  };
  app.id = 1;
  const st = chat(-720);
  for (const id of [-700, -701, -702, -703, -704, -705]) chat(id).settings.alerts = false;
  st.settings.alerts = true;
  const t0 = Date.now();
  let pages = { oborona_kr: post('oborona_kr', 18, t0 - 3600_000, END), kpszsu: post('kpszsu', 1, t0 - 1000, 'старый') };
  await alertsTick(t0, mkFetch(pages));
  log.length = 0;

  // 1) тревога объявлена, причины ещё нет
  pages = { ...pages, oborona_kr: pages.oborona_kr + post('oborona_kr', 19, t0 + 1000, START) };
  await alertsTick(t0 + 11_000, mkFetch(pages));
  const alarm = log.find((x) => x[0] === 'send');
  assert.match(alarm[2], /Причина: уточнюється/);

  // 2) вторым сообщением (ответом) пишут причину: закреплённое сообщение редактируется, отдельной карточки нет
  log.length = 0;
  pages = { ...pages, oborona_kr: pages.oborona_kr + reply('oborona_kr', 20, t0 + 15_000, 'Шахедна<br/>По реактивному зі сходу', 19, START) };
  await alertsTick(t0 + 22_000, mkFetch(pages));
  const edit = log.find((x) => x[0] === 'edit');
  assert.ok(edit, 'сообщение отредактировано');
  assert.equal(edit[1], alarm[1]);
  assert.match(edit[2], /^🚨 ПОВІТРЯНА ТРИВОГА\n📍 Кривий Ріг\nПричина: Шахедна · По реактивному зі сходу\n🕐 з /);
  assert.equal(log.filter((x) => x[0] === 'send').length, 0); // ответ-причина не пересылается отдельным сообщением

  // 3) повторный опрос ничего не меняет
  log.length = 0;
  await alertsTick(t0 + 33_000, mkFetch(pages));
  assert.equal(log.length, 0);

  // 4) ответ на какое-то другое сообщение причиной не считается
  pages = { ...pages, oborona_kr: pages.oborona_kr + reply('oborona_kr', 21, t0 + 40_000, 'Просто комментарий', 5, 'что-то старое') };
  await alertsTick(t0 + 44_000, mkFetch(pages));
  assert.equal(log.filter((x) => x[0] === 'edit').length, 0);
});
