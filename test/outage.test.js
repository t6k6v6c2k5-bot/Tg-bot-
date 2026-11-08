import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
process.env.OUTAGE_HOUR = '7';
process.env.QUIET_FROM = '0';
process.env.QUIET_TO = '6';
process.env.BOT_TZ = 'UTC';

const { parseGroup, listGroups, groupHash, outageCommand, outageTick, imageUrl, _resetOutageCache } = await import('../src/outage.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');
const { selfTalk, setSelfTalk } = await import('../src/owner.js');

const day = (a, b) => ({ 'GPV3.1': { 1: a }, 'GPV4.2': { 1: b } });
let data = { fact: { update: '08.11.2026 09:00', data: { 1000: day('yes', 'no') } } };
const fakeFetch = async (url) => {
  if (url.endsWith('.json')) return { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(data)) };
  return { ok: true, arrayBuffer: async () => Buffer.from('PNG') };
};

test('очередь разбирается из разных написаний', () => {
  assert.equal(parseGroup('3.1'), 'GPV3.1');
  assert.equal(parseGroup('черга 3,1 будь ласка'), 'GPV3.1');
  assert.equal(parseGroup('gpv4-2'), 'GPV4.2');
  assert.equal(parseGroup('3'), null);
  assert.equal(parseGroup('9.9', ['GPV3.1']), null);
  assert.deepEqual(listGroups(data), ['GPV3.1', 'GPV4.2']);
  assert.match(imageUrl('GPV3.1'), /images\/dnipro\/gpv-3-1\.png$/);
});

test('отпечаток меняется только при изменении своей очереди', () => {
  const h = groupHash(data, 'GPV3.1');
  const same = { fact: { data: { 1000: day('yes', 'yes') } } };
  assert.equal(groupHash(same, 'GPV3.1'), h);
  assert.notEqual(groupHash({ fact: { data: { 1000: day('no', 'no') } } }, 'GPV3.1'), h);
});

test('подписка, утренний график и сообщение при изменении', async () => {
  _resetOutageCache();
  const sent = [];
  app.telegram = {
    sendPhoto: async (id, f, o) => sent.push(['photo', id, o.caption]),
    sendMediaGroup: async (id, arr) => sent.push(['album', id, arr.length]),
    sendMessage: async (id, t) => (sent.push(['msg', id, t]), { message_id: sent.length }),
  };
  app.id = 1;
  const st = chat(-555);
  await outageCommand(-555, st, '3.1', 1, fakeFetch);
  assert.equal(sent[0][0], 'photo');
  assert.match(sent[0][2], /Черга 3\.1/);

  sent.length = 0;
  const morning = Date.UTC(2026, 10, 9, 8, 0); // 08:00 UTC
  await outageTick(morning, fakeFetch);
  assert.equal(sent.length, 1); // утренний
  assert.match(sent[0][2], /ранку/);

  data = { fact: { update: '09.11.2026 10:00', data: { 1000: day('no', 'no') } } };
  _resetOutageCache();
  sent.length = 0;
  await outageTick(morning + 11 * 60_000, fakeFetch);
  assert.equal(sent.length, 1);
  assert.match(sent[0][2], /змінився/);

  // ночью не будим
  data = { fact: { data: { 1000: day('yes', 'yes') } } };
  _resetOutageCache();
  sent.length = 0;
  await outageTick(Date.UTC(2026, 10, 10, 3, 0), fakeFetch);
  assert.equal(sent.length, 0);

  await outageCommand(-555, st, 'стоп 3.1', 1, fakeFetch);
  assert.deepEqual(Object.keys(st.outage.groups), []);
});

test('сам в чат не пишет по умолчанию', () => {
  assert.equal(selfTalk(), false);
  setSelfTalk(true);
  assert.equal(selfTalk(), true);
  setSelfTalk(false);
});
