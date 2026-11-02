import test from 'node:test';
import assert from 'node:assert/strict';
import { isCatchupRequest, hoursFromText, catchupWindow } from '../src/catchup.js';
import { pickPhoto, mediaKind, label, mediaBudgetOk } from '../src/media.js';

const H = 3600_000;
const NOW = 1_800_000_000_000;

test('«что я пропустил» распознаётся обычной речью', () => {
  for (const t of ['батя, что я пропустил?', 'что тут было', 'о чём говорили?', 'введи в курс', 'что было за ночь', 'перескажи чат', 'что нового']) assert.ok(isCatchupRequest(t), t);
  for (const t of ['привет', 'что будем есть', 'я был на работе']) assert.ok(!isCatchupRequest(t), t);
});

test('часы из текста', () => {
  assert.equal(hoursFromText('3'), 3);
  assert.equal(hoursFromText('за 5 часов'), 5);
  assert.equal(hoursFromText('100 ч'), 48);
  assert.equal(hoursFromText(''), null);
});

test('окно пересказа: с последнего сообщения человека, не меньше часа', () => {
  const st = { history: [
    { uid: 1, ts: NOW - 5 * H, text: 'ушёл' },
    { uid: 2, ts: NOW - 4 * H, text: 'болтаем' },
    { uid: 1, ts: NOW - 1000, text: 'батя, что я пропустил?' },
  ] };
  assert.equal(catchupWindow(st, 1, NOW, null).since, NOW - 5 * H);
  assert.equal(catchupWindow(st, 1, NOW, 2).since, NOW - 2 * H);
  const recent = { history: [{ uid: 1, ts: NOW - 5 * 60_000, text: 'a' }, { uid: 1, ts: NOW - 1000, text: 'b' }] };
  assert.equal(catchupWindow(recent, 1, NOW, null).since, NOW - H); // слишком короткое окно расширяем до часа
  const newcomer = { history: [{ uid: 1, ts: NOW - 1000, text: 'первое' }] };
  assert.equal(catchupWindow(newcomer, 1, NOW, null).since, NOW - 6 * H);
});

test('фото: берём самый крупный вариант в лимите', () => {
  const sizes = [{ file_size: 1e3 }, { file_size: 2e5 }, { file_size: 9e6 }];
  assert.equal(pickPhoto(sizes).file_size, 2e5);
  assert.equal(pickPhoto([{ file_size: 9e6 }, { file_size: 8e6 }]).file_size, 9e6); // всё тяжёлое — берём первое
});

test('тип медиа и подписи', () => {
  assert.equal(mediaKind({ voice: {} }), 'speech');
  assert.equal(mediaKind({ video_note: {} }), 'speech');
  assert.equal(mediaKind({ photo: [{}] }), 'photo');
  assert.equal(mediaKind({ sticker: {} }), null);
  assert.equal(label({ sticker: { emoji: '😂' } }), '[стикер 😂]');
});

test('лимит разборов медиа в час', () => {
  const st = { mediaLog: Array.from({ length: 15 }, (_, i) => NOW - i * 1000) };
  assert.equal(mediaBudgetOk(st, NOW), false);
  assert.equal(mediaBudgetOk(st, NOW + 2 * H), true);
});
