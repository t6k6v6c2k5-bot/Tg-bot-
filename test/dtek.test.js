import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dtek-'));

const { splitAddress, matchStreets, lookupGroup, DtekBlocked } = await import('../src/dtek.js');

const page = `<html><meta name="csrf-token" content="TOK"><script>DisconSchedule.streets = {"м. Кривий Ріг":["вул. Соборності","вул. Соборна","просп. Гагаріна","вул. Гагаріна"]};
DisconSchedule.preset = {"updateFact":"26.11.2026 07:21"}</script></html>`;

const mk = (houses, { blocked = false } = {}) => {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (blocked) return { ok: false, status: 403 };
    if (!opts.method) return { ok: true, text: async () => page, headers: { getSetCookie: () => ['sid=abc; path=/'] } };
    return { ok: true, text: async () => JSON.stringify({ result: true, data: houses }), headers: { getSetCookie: () => [] } };
  };
  f.calls = calls;
  return f;
};

test('адрес делится на улицу и номер дома', () => {
  assert.deepEqual(splitAddress('вул. Соборності 5'), { street: 'вул. Соборності', house: '5' });
  assert.deepEqual(splitAddress('Соборності 12а'), { street: 'Соборності', house: '12А' });
  assert.deepEqual(splitAddress('Соборності'), { street: 'Соборності', house: '' });
});

test('улица ищется без «вул.», точное совпадение приоритетнее', () => {
  const l = ['вул. Соборності', 'вул. Соборна', 'просп. Гагаріна', 'вул. Гагаріна'];
  assert.deepEqual(matchStreets(l, 'соборності'), ['вул. Соборності']);
  assert.deepEqual(matchStreets(l, 'Гагаріна'), ['просп. Гагаріна', 'вул. Гагаріна']);
  assert.deepEqual(matchStreets(l, 'збройних'), []);
});

test('очередь дома берётся с сайта ДТЕК, токен и cookie передаются', async () => {
  const f = mk({ 5: { sub_type_reason: ['GPV7.1'] }, '12А': { sub_type_reason: ['GPV8.1', 'GPV9.1'] } });
  const r = await lookupGroup('Соборності 5', f);
  assert.deepEqual(r, { status: 'ok', street: 'вул. Соборності', house: '5', groups: ['GPV7.1'] });
  const post = f.calls[1];
  assert.equal(post.opts.headers['x-csrf-token'], 'TOK');
  assert.equal(post.opts.headers.cookie, 'sid=abc');
  assert.match(post.opts.body, /method=getHomeNum/);
  assert.match(decodeURIComponent(post.opts.body.replace(/\+/g, ' ')), /м\. Кривий Ріг/);
  const r2 = await lookupGroup('Соборності 12а', mk({ '12А': { sub_type_reason: ['GPV8.1', 'GPV9.1'] } }));
  assert.deepEqual(r2.groups, ['GPV8.1', 'GPV9.1']);
});

test('нет дома / несколько улиц / нет улицы / защита сайта', async () => {
  assert.equal((await lookupGroup('Соборності 99', mk({ 5: { sub_type_reason: ['GPV7.1'] } }))).status, 'nohouse');
  assert.equal((await lookupGroup('Гагаріна 1', mk({}))).status, 'choose');
  assert.equal((await lookupGroup('Соборності', mk({}))).status, 'choose');
  assert.equal((await lookupGroup('Невідома 1', mk({}))).status, 'nostreet');
  await assert.rejects(lookupGroup('Соборності 5', mk({}, { blocked: true })), DtekBlocked);
});
