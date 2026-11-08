import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-'));
process.env.BOT_TZ = 'Europe/Moscow'; // бот может жить по Москве, а свет считается по Киеву
delete process.env.OUTAGE_TZ;

const { minutesNow, dayKey } = await import('../src/outage.js');
const { statusNow, statusAnswer } = await import('../src/outage-ask.js');

test('«сейчас» для света — по Киеву, а не по BOT_TZ', () => {
  const t = Date.UTC(2026, 10, 8, 10, 3); // 12:03 в Киеве зимой (Москва 13:03)
  assert.equal(minutesNow(t), 12 * 60 + 3);
  assert.equal(dayKey(Date.UTC(2026, 10, 8, 22, 30)), '2026-11-09'); // 00:30 по Киеву уже завтра
});

test('до включения: 12:03 → 14:00 это почти 2 часа, а не 1', () => {
  const t = Date.UTC(2026, 10, 8, 10, 3);
  const T0 = Date.UTC(2026, 10, 7, 22, 0) / 1000; // полночь по Киеву 08.11
  const data = { fact: { data: { [T0]: { 'GPV6.2': { 8: 'no', 9: 'no', 10: 'no', 11: 'no', 12: 'no', 13: 'no', 14: 'no' } } } } };
  const s = statusNow(data, 'GPV6.2', t);
  assert.equal(s.on, false);
  assert.equal(s.until, 14 * 60);
  assert.match(statusAnswer('GPV6.2', s, t), /через 2 ч/);
});
