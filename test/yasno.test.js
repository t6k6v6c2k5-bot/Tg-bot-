import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yasno-'));
process.env.OUTAGE_TZ = 'Europe/Kyiv';

const { slotsToHours, yasnoToData, fetchYasno } = await import('../src/yasno.js');
const { loadData, listGroups, offIntervals, _resetOutageCache } = await import('../src/outage.js');

const sample = {
  '1.1': {
    today: { date: '2026-11-26T00:00:00+02:00', status: 'ScheduleApplies', slots: [{ start: 0, end: 840, type: 'NotPlanned' }, { start: 840, end: 1050, type: 'Definite' }, { start: 1050, end: 1440, type: 'NotPlanned' }] },
    tomorrow: { date: '2026-11-27T00:00:00+02:00', status: 'WaitingForSchedule', slots: [] },
    updatedOn: '2026-11-26T05:21:00+00:00',
  },
  '6.2': {
    today: { date: '2026-11-26T00:00:00+02:00', status: 'ScheduleApplies', slots: [{ start: 600, end: 900, type: 'Definite' }] },
    tomorrow: { date: '2026-11-27T00:00:00+02:00', status: 'ScheduleApplies', slots: [{ start: 60, end: 120, type: 'Definite' }] },
    updatedOn: '2026-11-26T11:30:00+00:00',
  },
};

test('слоты в минутах превращаются в часы: целые и половинки', () => {
  const h = slotsToHours([{ start: 840, end: 1050, type: 'Definite' }]); // 14:00–17:30
  assert.equal(h[14], 'yes'); // час 14 = 13:00–14:00
  assert.equal(h[15], 'no'); // 14:00–15:00
  assert.equal(h[17], 'no');
  assert.equal(h[18], 'first'); // 17:00–18:00: отключено до 17:30
  assert.equal(h[19], 'yes');
  assert.deepEqual(offIntervals(h).off, [[840, 1050]]);
});

test('ответ Yasno приводится к формату модуля света, день без графика пропускается', () => {
  const d = yasnoToData(sample, 'Europe/Kyiv');
  assert.deepEqual(listGroups(d), ['GPV1.1', 'GPV6.2']);
  const days = Object.keys(d.fact.data);
  assert.equal(days.length, 2); // завтра есть только у 6.2
  assert.equal(d.fact.update, '26.11.2026 13:30');
  assert.equal(d.source, 'yasno');
  assert.throws(() => yasnoToData({}), /нет действующих/);
});

test('loadData берёт Yasno, а при сбое — репозиторий', async () => {
  _resetOutageCache();
  const urls = [];
  const ok = async (url) => (urls.push(url), { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(sample)) });
  const d = await loadData(ok, 1);
  assert.match(urls[0], /regions\/3\/dsos\/301\/planned-outages$/);
  assert.equal(d.source, 'yasno');

  _resetOutageCache();
  const repo = { fact: { update: 'x', data: { 1: { 'GPV3.1': { 1: 'yes' } } } } };
  const blocked = async (url) => (url.includes('yasno') ? { ok: false, status: 403 } : { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(repo)) });
  const d2 = await loadData(blocked, 1);
  assert.deepEqual(listGroups(d2), ['GPV3.1']);
  await assert.rejects(fetchYasno(blocked), /HTTP 403/);
});

test('старая очередь 6.2 = новая 12.1: разбор и пояснение', async () => {
  const { parseGroup, legacyNote, parseMyQueue } = await import('../src/outage.js');
  const known = ['GPV1.1', 'GPV12.1'];
  assert.equal(parseGroup('6.2', known), 'GPV12.1');
  assert.equal(parseGroup('6.2'), 'GPV12.1');
  assert.equal(parseGroup('12.1', known), 'GPV12.1');
  assert.equal(parseGroup('5.2', known), null);
  assert.equal(parseMyQueue('моя очередь 6.2'), 'GPV12.1');
  assert.match(legacyNote('где график 6.2?'), /6\.2 теперь называется 12\.1/);
  assert.equal(legacyNote('график 12.1'), '');
  // если 6.2 снова появится в данных, она остаётся собой
  assert.equal(parseGroup('6.2', ['GPV6.2', 'GPV12.1']), 'GPV6.2');
});

test('старая очередь 2.2 = новая 4.1', async () => {
  const { parseGroup, legacyNote } = await import('../src/outage.js');
  assert.equal(parseGroup('2.2', ['GPV4.1']), 'GPV4.1');
  assert.match(legacyNote('где график 2.2'), /2\.2 теперь называется 4\.1/);
});

test('таблица «было → стало» из канала ЭКРД', async () => {
  const { parseGroup, legacyNote } = await import('../src/outage.js');
  const all = Array.from({ length: 18 }, (_, i) => `GPV${i + 1}.1`);
  const table = { '1.2': '2.1', '2.2': '4.1', '3.2': '6.1', '4.2': '8.1', '5.2': '10.1', '6.2': '12.1' };
  for (const [old, now] of Object.entries(table)) assert.equal(parseGroup(old, all), `GPV${now}`, old);
  assert.match(legacyNote('график 4.2', all), /4\.2 теперь называется 8\.1/);
  // имя, которое осталось в данных, могло быть и старым, и новым: показываем новое и подсказываем перевод
  assert.equal(parseGroup('3.1', all), 'GPV3.1');
  assert.match(legacyNote('график 3.1', all), /Это новая 3\.1\. Если ты имел в виду старую 3\.1, то теперь она 5\.1/);
  assert.equal(legacyNote('график 1.1', all), ''); // 1.1 не менялась
  assert.equal(legacyNote('график 12.1', all), '');
});

test('записанная очередь 4.2 переезжает на 8.1, а 3.1 остаётся', async () => {
  const { migrateUsers, movedText } = await import('../src/outage.js');
  const known = Array.from({ length: 18 }, (_, i) => `GPV${i + 1}.1`);
  const o = { users: { 1: { group: 'GPV4.2', name: 'Дарина' }, 2: { group: 'GPV3.1', name: 'Оля' }, 3: { group: 'GPV12.1', name: 'Влад' } }, hashes: { 'GPV8.1': 'x' } };
  const moved = migrateUsers(o, known);
  assert.deepEqual(moved.map((m) => [m.name, m.from, m.to]), [['Дарина', 'GPV4.2', 'GPV8.1']]);
  assert.equal(o.users[1].group, 'GPV8.1');
  assert.equal(o.users[2].group, 'GPV3.1');
  assert.equal(o.hashes['GPV8.1'], undefined);
  assert.match(movedText(moved), /Дарина 4\.2 → 8\.1/);
  assert.deepEqual(migrateUsers(o, known), []); // повторно ничего не делает
});
