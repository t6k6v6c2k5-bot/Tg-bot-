import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-'));
delete process.env.BOT_TZ;

const { isTimeQuestion, timeAnswer } = await import('../src/clock.js');

test('вопрос про время распознаётся, обычная болтовня нет', () => {
  for (const q of ['Батя, сколько время?', 'Сколько времени сейчас?', 'Батя, время', 'который час', 'скільки зараз часу', 'котра година?']) assert.ok(isTimeQuestion(q), q);
  for (const q of ['время вышло, всем спать', 'сколько времени ты потратил на это', 'как дела', 'время работы магазина?']) assert.ok(!isTimeQuestion(q), q);
});

test('время по умолчанию киевское', () => {
  assert.equal(timeAnswer(Date.UTC(2026, 10, 8, 10, 17)), '🕐 В Києві зараз 12:17.');
});
