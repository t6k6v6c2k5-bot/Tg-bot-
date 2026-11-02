import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// DATA_DIR нужно выставить ДО первой загрузки конфигурации, поэтому отдельный файл (отдельный процесс) и динамический импорт
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migr-'));
process.env.DATA_DIR = dir;
fs.writeFileSync(
  path.join(dir, 'state.json'),
  JSON.stringify({
    '-100': { settings: { activity: 4, tone: 'soft', mutedUntil: 0, autonomy: true }, optOut: { 5: true }, memOff: { 6: true } },
    '-200': { settings: { v: 2, activity: 2, tone: 'hard', crude: 1, mutedUntil: 0, autonomy: true } }, // уже мигрирован и выбран вручную
  }),
);
const { load, chat } = await import('../src/store.js');

test('старый чат мигрирует на «без рамок», остальные настройки и выбор людей не трогаем', () => {
  load();
  const c = chat(-100);
  assert.equal(c.settings.tone, 'free');
  assert.equal(c.settings.crude, 3);
  assert.equal(c.settings.v, 2);
  assert.equal(c.settings.activity, 4);
  assert.deepEqual(c.optOut, { 5: true }); // /неподкалывай уважается
  assert.deepEqual(c.memOff, { 6: true }); // /забудь уважается
});

test('уже мигрированный чат с ручными настройками не перезаписывается', () => {
  const c = chat(-200);
  assert.equal(c.settings.tone, 'hard');
  assert.equal(c.settings.crude, 1);
  assert.equal(c.settings.activity, 2);
});

test('новый чат сразу «без рамок»', () => {
  const c = chat(-999);
  assert.equal(c.settings.tone, 'free');
  assert.equal(c.settings.crude, 3);
});
