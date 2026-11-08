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

const { parseGroup, listGroups, groupHash, outageCommand, outageTick, imageUrl, offIntervals, setUserGroup, parseMyQueue, _resetOutageCache } = await import('../src/outage.js');
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

test('интервалы без света склеиваются, половины часа считаются', () => {
  const sched = { 1: 'no', 2: 'no', 3: 'first', 12: 'second', 13: 'no', 20: 'maybe' };
  const r = offIntervals(sched);
  assert.deepEqual(r.off, [[0, 150], [690, 780]]);
  assert.deepEqual(r.maybe, [[1140, 1200]]);
});

test('запоминает очередь человека, утром пишет по очередям, при изменении тегает', async () => {
  _resetOutageCache();
  const sent = [];
  app.telegram = {
    sendPhoto: async (id, f, o) => sent.push(['photo', id, o.caption]),
    sendMessage: async (id, t, o) => (sent.push(['msg', id, t, o?.entities]), { message_id: sent.length }),
  };
  app.id = 1;
  const st = chat(-555);
  const vlad = { id: 10, first_name: 'Влад' };
  const olya = { id: 11, first_name: 'Оля', username: 'olya' };
  const t0 = Date.UTC(2026, 10, 9, 8, 0); // 08:00 UTC
  const base = { 'GPV3.1': { 5: 'no', 6: 'no' }, 'GPV4.2': { 1: 'yes' }, 'GPV5.2': { 1: 'yes' } };
  data = { fact: { update: 'x', data: { [Date.UTC(2026, 10, 9) / 1000]: base } } };
  await outageCommand(-555, st, '3.1', 1, vlad, fakeFetch);
  assert.match(sent[0][2], /Черга 3\.1 \(Влад\)/);
  assert.match(sent[0][2], /04:00–06:00/);
  setUserGroup(st, olya, 'GPV4.2', data);
  assert.equal(parseMyQueue('у меня очередь 4.2'), 'GPV4.2');
  assert.equal(parseMyQueue('просто текст'), null);

  sent.length = 0;
  await outageTick(t0, fakeFetch);
  assert.equal(sent.length, 1);
  assert.match(sent[0][2], /Доброго ранку/);
  assert.match(sent[0][2], /• 3\.1 \(Влад\): 04:00–06:00/);
  assert.match(sent[0][2], /• 4\.2 \(Оля\): без відключень/);
  assert.match(sent[0][2], /• 5\.2: без відключень/); // очереди без людей тоже в общей сводке

  data = { fact: { update: 'y', data: { [Date.UTC(2026, 10, 9) / 1000]: { ...base, 'GPV3.1': { 5: 'no' } } } } };
  _resetOutageCache();
  sent.length = 0;
  await outageTick(t0 + 11 * 60_000, fakeFetch);
  assert.equal(sent.length, 1);
  assert.match(sent[0][2], /змінився \(черги: 3\.1\)/);
  assert.match(sent[0][2], /🔄 3\.1 \(Влад\): 04:00–05:00/);
  assert.match(sent[0][2], /• 4\.2 \(Оля\)/); // остальные очереди тоже в сводке, но без пометки
  assert.equal(sent[0][3]?.[0]?.type, 'text_mention'); // у Влада нет ника — тег через text_mention

  // вечером — сводка на завтра, как только завтрашний график вышел
  const tomorrow = { [Date.UTC(2026, 10, 9) / 1000]: base, [Date.UTC(2026, 10, 10) / 1000]: { 'GPV3.1': { 20: 'no' }, 'GPV4.2': { 1: 'yes' } } };
  data = { fact: { data: tomorrow } };
  _resetOutageCache();
  sent.length = 0;
  await outageTick(Date.UTC(2026, 10, 9, 20, 30), fakeFetch);
  assert.equal(sent.length, 1);
  assert.match(sent[0][2], /Добрий вечір/);
  assert.match(sent[0][2], /Завтра \(10\.11\)/);
  assert.doesNotMatch(sent[0][2], /Сьогодні/);

  // ночью не будим
  data = { fact: { data: { [Date.UTC(2026, 10, 10) / 1000]: { 'GPV3.1': { 1: 'no' } } } } };
  _resetOutageCache();
  sent.length = 0;
  await outageTick(Date.UTC(2026, 10, 10, 3, 0), fakeFetch);
  assert.equal(sent.length, 0);

  await outageCommand(-555, st, 'стоп', 1, vlad, fakeFetch);
  assert.equal(st.outage.users[10], undefined);
});

test('сам в чат не пишет по умолчанию', () => {
  assert.equal(selfTalk(), false);
  setSelfTalk(true);
  assert.equal(selfTalk(), true);
  setSelfTalk(false);
});
