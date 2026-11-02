import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'own-'));
process.env.ADMIN_IDS = '777';
delete process.env.GROQ_API_KEY;
process.env.GEMINI_API_KEY = 'key-OWN';

const { isModelQuestion, wantsJoke } = await import('../src/filter.js');
const { isAdminId, ownerSerious, setOwnerSerious } = await import('../src/owner.js');
const { modelAnswer } = await import('../src/about.js');
const { mainMenu } = await import('../src/admin.js');

test('вопрос про модель распознаётся', () => {
  assert.ok(isModelQuestion('какая версия ии ты сейчас используешь?'));
  assert.ok(isModelQuestion('на какой модели работаешь'));
  assert.ok(!isModelQuestion('какая сегодня погода'));
});

test('просьба пошутить отменяет серьёзный режим', () => {
  assert.ok(wantsJoke('Батя, пошути'));
  assert.ok(!wantsJoke('как дела'));
  assert.ok(!wantsJoke('без шуток'));
});

test('админ по ADMIN_IDS, режим серьёзно по умолчанию включён и переключается', () => {
  assert.ok(isAdminId(777));
  assert.ok(!isAdminId(1));
  assert.equal(ownerSerious(), true);
  setOwnerSerious(false);
  assert.equal(ownerSerious(), false);
  assert.match(mainMenu().kb.inline_keyboard.flat().map((b) => b.text).join('|'), /как обычно/);
  setOwnerSerious(true);
});

test('ответ про модель берётся из реальных данных', () => {
  const a = modelAnswer(Date.now(), { RAILWAY_GIT_COMMIT_SHA: 'abcdef123456' });
  assert.match(a, /Gemini/);
  assert.match(a, /abcdef1/);
});

test('выключатель бота', async () => {
  const { botOff, setBotOff } = await import('../src/owner.js');
  assert.equal(botOff(), false);
  setBotOff(true);
  assert.equal(botOff(), true);
  assert.match(mainMenu().text, /ВЫКЛЮЧЕН/);
  setBotOff(false);
  assert.equal(botOff(), false);
});

test('буквы чужих письменностей в реплике — отбрасываем', async () => {
  const { parseReply } = await import('../src/parse.js');
  assert.equal(parseReply('Семья полным составом: один батя с боารом').type, 'skip');
  assert.equal(parseReply('Нормальная реплика про батю').type, 'text');
});
