import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-'));
process.env.BOT_ALIASES = 'батя,бот';

const { renameNote } = await import('../src/rename.js');

const NOW = Date.now();
const mk = () => ({
  history: [
    { uid: 5, name: 'Sky', text: 'Батя, называй меня мой господин', ts: NOW - 20 * 60_000 },
    { uid: 1, bot: true, name: 'Батя', text: 'Господином будешь у мамки на кухне', ts: NOW - 19 * 60_000 },
    { uid: 5, name: 'Sky', text: 'Называй меня пожалуйста мой господин', ts: NOW - 18 * 60_000 },
  ],
  users: {},
});

test('смена имени «под просьбу» — повод ответить, с нужным контекстом', () => {
  const st = mk();
  const note = renameNote(st, 5, { from: 'Sky', to: 'Мой господин' }, NOW);
  assert.match(note, /Sky/);
  assert.match(note, /Мой господин/);
  assert.match(note, /НЕ называй/);
});

test('повторно в течение 6 часов — нет', () => {
  const st = mk();
  assert.ok(renameNote(st, 5, { from: 'Sky', to: 'Мой господин' }, NOW));
  assert.equal(renameNote(st, 5, { from: 'Мой господин', to: 'Мой повелитель' }, NOW + 60_000), null);
});

test('обычная смена имени без связи с ботом — молчим', () => {
  const st = { history: [{ uid: 7, name: 'Оля', text: 'всем привет', ts: NOW - 60_000 }], users: {} };
  assert.equal(renameNote(st, 7, { from: 'Оля', to: 'Ольга' }, NOW), null);
  assert.equal(renameNote(mk(), 5, { from: 'Sky', to: 'Sky' }, NOW), null);
});
