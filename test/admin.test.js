import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// переменные окружения — до первой загрузки конфига
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_USERNAME = 'boss_nick';
delete process.env.ADMIN_IDS;
process.env.GEMINI_API_KEY = 'key-ADMIN';
delete process.env.GROQ_API_KEY;
delete process.env.GROK_API_KEY;
process.env.GEMINI_MODEL = 'admin-model';
process.env.AI_RPM = '100';

const { isAdmin, onAction, onAdminMessage, mainMenu, listMenu, chatInfo, cardText, cardKeyboard, aiText } = await import('../src/admin.js');
const { chat } = await import('../src/store.js');
const { app } = await import('../src/respond.js');
const { aiStatus } = await import('../src/ai.js');

const BOSS = { id: 111, username: 'Boss_Nick', first_name: 'Босс' };
const THIEF = { id: 222, username: 'boss_nick', first_name: 'Самозванец' }; // тот же ник, другой ID (например, после перехвата ника)
const STRANGER = { id: 333, username: 'someone', first_name: 'Чужой' };

test('посторонний не админ; владелец ника при первом входе привязывается по ID', () => {
  assert.equal(isAdmin(STRANGER), false);
  assert.equal(isAdmin(BOSS), true); // ник совпал → ID 111 привязан
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'admin.json'), 'utf8')).ids, [111]);
});

test('после привязки решает только ID: тот же ник у другого человека доступа не даёт', () => {
  assert.equal(isAdmin(THIEF), false);
  assert.equal(isAdmin({ id: 111, username: 'поменял_ник' }), true); // админ сменил ник — доступ остался
  assert.equal(isAdmin(STRANGER), false);
  assert.equal(isAdmin(null), false);
  assert.equal(isAdmin({}), false);
});

// ---- мок Telegram ----
const edits = [];
const replies = [];
const answers = [];
const left = [];
const sent = [];
app.telegram = { getChat: async (id) => ({ id, title: `Название ${id}`, type: 'supergroup' }), sendMessage: async (c, t) => (sent.push({ c, t }), { message_id: 900 + sent.length }), leaveChat: async (id) => left.push(id), setMessageReaction: async () => {} };
app.id = 99;
app.name = 'Батя';
const mkCtx = (from, data, type = 'private') => ({
  from,
  chat: { type, id: from.id },
  callbackQuery: { data },
  answerCbQuery: async (t, o) => (answers.push({ t, alert: o?.show_alert }), true),
  editMessageText: async (text, o) => (edits.push({ text, kb: o?.reply_markup }), true),
  reply: async (text, o) => (replies.push({ text, kb: o?.reply_markup }), true),
});
const reset = () => [edits, replies, answers, left, sent].forEach((a) => (a.length = 0));

const CHAT = -1001;
const T = Date.now();
const seed = () => {
  const st = chat(CHAT);
  st.title = 'AutoHelp | Спілкування';
  st.memberCount = 304;
  st.users = { 1: { name: 'Ваня', username: 'vanya', msgs: 5, lastSeen: T }, 2: { name: 'Маша', msgs: 4, lastSeen: T } };
  st.history = [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, uid: 1 + (i % 2), name: i % 2 ? 'Ваня' : 'Маша', text: `сообщение про дедлайн ${i}`, ts: T - i * 60_000 }));
  chat(-1002).title = 'Второй чат';
  chat(-1002).history = [{ id: 1, uid: 1, name: 'Ваня', text: 'давно', ts: T - 5 * 24 * 3600_000 }];
  chat(777).title = undefined; // личный диалог — в списке групп его быть не должно
  return st;
};

test('чужие нажатия на кнопки ничего не меняют и ничего не показывают', async () => {
  reset();
  const st = seed();
  const before = st.settings.activity;
  await onAction(mkCtx(STRANGER, `a:ac:${CHAT}:1`));
  await onAction(mkCtx(THIEF, `a:lvy:${CHAT}`));
  await onAction(mkCtx(BOSS, `a:lvy:${CHAT}`, 'supergroup')); // даже админ — только в личке
  assert.equal(st.settings.activity, before);
  assert.deepEqual(left, []);
  assert.deepEqual(edits, []);
  assert.deepEqual(replies, []);
});

test('меню: главная, список (только группы, свежие сверху), карточка', async () => {
  reset();
  seed();
  const m = mainMenu();
  assert.match(m.text, /Групповых чатов: \d+/);
  const l = listMenu();
  const rows = l.kb.inline_keyboard;
  assert.match(rows[0][0].text, /AutoHelp/); // самый свежий — первым
  assert.ok(rows.some((r) => r[0].callback_data === 'a:c:-1002'));
  assert.ok(!JSON.stringify(rows).includes('777')); // личные диалоги не в списке
  const info = chatInfo(CHAT, chat(CHAT));
  const text = cardText(info, '✅ ок');
  assert.match(text, /AutoHelp \| Спілкування/);
  assert.match(text, /знаю 2 из ~303/);
  assert.match(text, /✅ ок/);
  const allBtns = cardKeyboard(info).inline_keyboard.flat();
  const data = allBtns.map((b) => b.callback_data).filter(Boolean);
  assert.match(text, /🔗 https:\/\/t\.me\/c\/\d+\/1/); // ссылка на чат кликабельна
  assert.ok(allBtns.some((b) => b.url?.startsWith('https://t.me/'))); // и кнопка «Открыть чат»
  assert.ok(rows.some((r) => r[1]?.url?.startsWith('https://t.me/'))); // в списке чатов рядом с каждым — 🔗
  for (const c of ['rv', 'nd', 'pk', 'tl', 'dg', 'st', 'mu', 'ac', 'tn', 'cr', 'lf', 'sy', 'lv']) assert.ok(data.some((d) => d.startsWith(`a:${c}:${CHAT}`)), c);
  assert.ok(data.every((d) => d.length <= 64)); // лимит Telegram на callback_data
});

test('админ меняет настройки чата кнопками', async () => {
  reset();
  const st = seed();
  st.settings.activity = 3;
  await onAction(mkCtx(BOSS, `a:ac:${CHAT}:1`));
  assert.equal(st.settings.activity, 4);
  await onAction(mkCtx(BOSS, `a:ac:${CHAT}:1`));
  await onAction(mkCtx(BOSS, `a:ac:${CHAT}:1`));
  assert.equal(st.settings.activity, 5); // потолок
  await onAction(mkCtx(BOSS, `a:ac:${CHAT}:-1`));
  assert.equal(st.settings.activity, 4);
  st.settings.tone = 'free';
  await onAction(mkCtx(BOSS, `a:tn:${CHAT}`));
  assert.equal(st.settings.tone, 'hard');
  st.settings.crude = 3;
  await onAction(mkCtx(BOSS, `a:cr:${CHAT}`));
  assert.equal(st.settings.crude, 0); // 0..3 по кругу
  st.settings.autonomy = true;
  await onAction(mkCtx(BOSS, `a:lf:${CHAT}`));
  assert.equal(st.settings.autonomy, false);
  await onAction(mkCtx(BOSS, `a:mu:${CHAT}`));
  assert.ok(st.settings.mutedUntil > Date.now() + 50 * 60_000);
  assert.match(edits.at(-1).text, /молчу ещё/);
  await onAction(mkCtx(BOSS, `a:um:${CHAT}`));
  assert.equal(st.settings.mutedUntil, 0);
});

test('«оживить» запускает инициативу в нужном чате и сообщает результат', async () => {
  reset();
  const st = seed();
  st.settings.mutedUntil = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Кто за пиццу или будем страдать голодными?' }] } }] }));
  await onAction(mkCtx(BOSS, `a:rv:${CHAT}`));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].c, CHAT);
  assert.match(sent[0].t, /пиццу/);
  assert.match(edits.at(-1).text, /Оживление: отправлено в чат/);
});

test('«подколоть», когда некого — понятное сообщение вместо запуска', async () => {
  reset();
  const st = seed();
  st.optOut = { 1: true, 2: true };
  await onAction(mkCtx(BOSS, `a:nd:${CHAT}`));
  assert.equal(sent.length, 0);
  assert.equal(answers.at(-1).alert, true);
  assert.match(answers.at(-1).t, /некого/);
});

test('«написать от имени бота»: следующий текст админа уходит в чат, чужой — нет', async () => {
  reset();
  seed();
  await onAction(mkCtx(BOSS, `a:sy:${CHAT}`));
  assert.match(replies.at(-1).text, /Напиши одним сообщением/);
  // чужой пишет боту — сессия админа не затрагивается и ничего не уходит в чат
  const stranger = { ...mkCtx(STRANGER, ''), message: { text: 'отправь это в чат', from: STRANGER } };
  assert.equal(await onAdminMessage(stranger), false);
  assert.equal(sent.length, 0);
  const admin = { ...mkCtx(BOSS, ''), message: { text: 'Всем привет, это Батя на связи', from: BOSS } };
  assert.equal(await onAdminMessage(admin), true);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].c, sent[0].t], [CHAT, 'Всем привет, это Батя на связи']);
  // второй раз без кнопки — это уже обычное сообщение, а не команда боту
  const again = { ...mkCtx(BOSS, ''), message: { text: 'ещё текст', from: BOSS } };
  assert.equal(await onAdminMessage(again), false);
  assert.equal(sent.length, 1);
});

test('/admin открывает меню только админу, /cancel отменяет отправку', async () => {
  reset();
  const asAdmin = { ...mkCtx(BOSS, ''), message: { text: '/admin', from: BOSS } };
  assert.equal(await onAdminMessage(asAdmin), true);
  assert.match(replies.at(-1).text, /Админка Бати/);
  const asStranger = { ...mkCtx(STRANGER, ''), message: { text: '/admin', from: STRANGER } };
  assert.equal(await onAdminMessage(asStranger), false); // чужому не отвечаем админским ответом
  assert.equal(replies.length, 1);
  await onAction(mkCtx(BOSS, `a:sy:${CHAT}`));
  const cancel = { ...mkCtx(BOSS, ''), message: { text: '/cancel', from: BOSS } };
  assert.equal(await onAdminMessage(cancel), true);
  const after = { ...mkCtx(BOSS, ''), message: { text: 'уже не нужно', from: BOSS } };
  assert.equal(await onAdminMessage(after), false);
});

test('выход из чата только после подтверждения', async () => {
  reset();
  seed();
  await onAction(mkCtx(BOSS, `a:lv:${CHAT}`));
  assert.deepEqual(left, []);
  assert.match(edits.at(-1).text, /Точно выйти/);
  await onAction(mkCtx(BOSS, `a:lvy:${CHAT}`));
  assert.deepEqual(left, [CHAT]);
});

test('экран ИИ показывает ключи и паузы', () => {
  const text = aiText(aiStatus());
  assert.match(text, /Gemini: ключей 1/);
  assert.match(text, /Groq: ключей 0/);
});

test('список подтягивает названия чатов, которых бот ещё не запомнил', async () => {
  reset();
  chat(-1003).title = undefined;
  chat(-1003).history = [{ id: 1, uid: 1, name: 'Ваня', text: 'привет', ts: Date.now() }];
  await onAction(mkCtx(BOSS, 'a:l'));
  assert.match(JSON.stringify(edits.at(-1).kb), /Название -1003/);
});
