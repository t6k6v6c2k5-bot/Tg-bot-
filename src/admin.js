import { config } from './config.js';
import { botMode, setBotMode, MODES, NEXT } from './botmode.js';
import { isAdminId, hasAdmins, bindAdmin, ownerSerious, setOwnerSerious, botOff, setBotOff, selfTalk, setSelfTalk, _resetOwner } from './owner.js';
import { allChats, chat, save, dayKey } from './store.js';
import { app, say } from './respond.js';
import { runInitiative, pickNeedleTarget, pickPokeTarget, dailyCap, engagement } from './life.js';
import { sendDigest } from './commands.js';
import { aiStatus } from './ai.js';
import { members, statsText } from './analysis.js';

// Админка в личке с ботом: доступ только по Telegram-ID администратора, все действия — кнопками.

const H = 3600_000;

// ---------- доступ ----------

/**
 * Админ — тот, чей числовой ID задан в ADMIN_IDS или уже привязан.
 * Если ни того ни другого нет, первым админом становится владелец ника ADMIN_USERNAME (его ID запоминается;
 * после этого ник уже ничего не решает, так что смена или перехват ника доступ не даёт).
 */
export function isAdmin(from) {
  if (!from?.id) return false;
  if (isAdminId(from.id)) return true;
  if (!hasAdmins() && config.adminUsername && from.username?.toLowerCase() === config.adminUsername) {
    bindAdmin(from.id);
    return true;
  }
  return false;
}

export const _resetAdminForTests = _resetOwner;

// ---------- тексты ----------
const ago = (ms) => {
  if (ms < 90_000) return 'только что';
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} мин назад`;
  if (ms < 36 * H) return `${Math.round(ms / H)} ч назад`;
  return `${Math.round(ms / (24 * H))} дн назад`;
};
const lastHuman = (st) => [...st.history].reverse().find((m) => !m.bot)?.ts ?? 0;
const TONES = { free: 'сам решает', hard: 'жёсткий', soft: 'мягкий' };
const TONE_NEXT = { free: 'hard', hard: 'soft', soft: 'free' };

export const groups = () => allChats().filter(([id]) => id < 0);

export function chatInfo(id, st, now = Date.now()) {
  const used = (st.initLog || []).filter((t) => now - t < 24 * H).length;
  const msgs24 = st.history.filter((m) => !m.bot && now - m.ts < 24 * H).length;
  const last = lastHuman(st);
  const withFacts = Object.values(st.memory?.users || {}).filter((f) => f.length).length;
  return {
    id,
    title: st.title || `Чат ${id}`,
    known: members(st).length,
    total: st.memberCount ? st.memberCount - 1 : null,
    last,
    msgs24,
    activity: st.settings.activity,
    tone: st.settings.tone || 'free',
    crude: st.settings.crude ?? 3,
    life: st.settings.autonomy !== false,
    mutedMin: st.settings.mutedUntil > now ? Math.ceil((st.settings.mutedUntil - now) / 60_000) : 0,
    used,
    cap: dailyCap(st),
    engage: Math.round(engagement(st) * 100),
    memPeople: withFacts,
    memMemes: (st.memory?.memes || []).length,
    mode: botMode(st),
    hardcore: st.settings.hardcore === true,
    now,
  };
}

export function cardText(i, note = '') {
  return [
    `💬 ${i.title}`,
    `ID: ${i.id}`,
    `Участники: знаю ${i.known}${i.total ? ` из ~${i.total}` : ''}. Писали за сутки: ${i.msgs24} сообщ. Последнее: ${i.last ? ago(i.now - i.last) : 'нет'}.`,
    `Активность ${i.activity}/5 · тон: ${TONES[i.tone] || i.tone} · пошлость ${i.crude} · своя жизнь: ${i.life ? 'вкл' : 'выкл'}${i.mutedMin ? ` · 🤫 молчу ещё ${i.mutedMin} мин` : ''}`,
    `Режим: ${MODES[i.mode]}${i.hardcore ? ' · ☠️ ХАРДКОР' : ''}`,
    `Инициатив за сутки: ${i.used}/${i.cap} (отзывчивость чата ${i.engage}%).`,
    `Память: людей с записями ${i.memPeople}, мемов ${i.memMemes}.`,
    note ? `\n${note}` : '',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

const btn = (text, data) => ({ text, callback_data: data });

export function cardKeyboard(i) {
  const c = (cmd, arg) => `a:${cmd}:${i.id}${arg != null ? ':' + arg : ''}`;
  return {
    inline_keyboard: [
      [btn('🔥 Оживить', c('rv')), btn('😈 Подколоть с тегом', c('nd'))],
      [btn('👋 Позвать молчуна', c('pk')), btn('📖 Байка', c('tl'))],
      [btn('📰 Итоги дня', c('dg')), btn('📊 Статистика', c('st'))],
      i.mutedMin ? [btn('🔊 Снять тишину', c('um'))] : [btn('🤫 Тихо на 1 ч', c('mu'))],
      [btn('➖', c('ac', -1)), btn(`Активность ${i.activity}`, c('c')), btn('➕', c('ac', 1))],
      [btn(`Тон: ${TONES[i.tone] || i.tone}`, c('tn')), btn(`Пошлость: ${i.crude}`, c('cr'))],
      [btn(`Режим: ${MODES[i.mode]}`, c('bm')), btn(i.hardcore ? '☠️ Хардкор: ВКЛ' : '☠️ Хардкор: выкл', c('hc'))],
      [btn(i.life ? '🌱 Жизнь: вкл' : '💤 Жизнь: выкл', c('lf'))],
      [btn('✉️ Написать от имени бота', c('sy')), btn('🚪 Выйти из чата', c('lv'))],
      [btn('⬅️ К списку', 'a:l'), btn('🔄', c('c'))],
    ],
  };
}

export function mainMenu(now = Date.now()) {
  const g = groups();
  const active = g.filter(([, st]) => now - lastHuman(st) < 24 * H).length;
  const dms = allChats().filter(([id]) => id > 0).length;
  return {
    text: `🛠 Админка Бати${botOff() ? ' (БОТ ВЫКЛЮЧЕН: молчит везде)' : ''}\nГрупповых чатов: ${g.length} (активных за сутки: ${active}). Личных диалогов: ${dms}.`,
    kb: { inline_keyboard: [[btn('📋 Чаты', 'a:l')], [btn('🤖 ИИ и ключи', 'a:ai')], [btn(selfTalk() ? '🗣 Сам пишет: да' : '🤐 Сам пишет: нет (только графики света)', 'a:stk')], [btn(botOff() ? '🔴 Бот выключен — включить' : '🟢 Бот включён — выключить', 'a:off')], [btn(ownerSerious() ? '🎩 Со мной: серьёзно' : '🎭 Со мной: как обычно', 'a:os')], [btn('🔄 Обновить', 'a:m')]] },
  };
}

export function listMenu(now = Date.now()) {
  const g = groups()
    .map(([id, st]) => ({ id, st, last: lastHuman(st) }))
    .sort((a, b) => b.last - a.last)
    .slice(0, 20);
  if (!g.length) return { text: '📋 Чатов пока нет: бот ещё не видел ни одной группы.', kb: { inline_keyboard: [[btn('⬅️ Назад', 'a:m')]] } };
  const rows = g.map(({ id, st, last }) => [btn(`${(st.title || `Чат ${id}`).slice(0, 30)} · ${last ? ago(now - last) : '—'}`, `a:c:${id}`)]);
  rows.push([btn('⬅️ Назад', 'a:m')]);
  return { text: `📋 Чаты, где есть бот (${groups().length}). Нажми, чтобы управлять:`, kb: { inline_keyboard: rows } };
}

export function aiText(s) {
  const lines = [
    '🤖 ИИ и ключи',
    `Gemini: ключей ${s.gemini.keys}, модели: ${s.gemini.models.join(', ')}`,
    `Groq: ключей ${s.groq.keys}${s.groq.keys ? `, модели: ${s.groq.models.join(', ')}` : ''}`,
    `Grok (xAI): ${s.grok.enabled ? 'есть' : 'нет'}`,
    ...(s.extra || []).map((e) => `${e.name}: ключей ${e.keys}, модели: ${e.models.join(', ')}`),
    `Запросов за минуту: ${s.callsLastMinute}`,
  ];
  if (s.pauses.length) {
    lines.push('', 'На паузе сейчас:');
    for (const p of s.pauses.slice(0, 12)) lines.push(`• ${p.id.replace(/^[mk]:/, '')} — ещё ${p.seconds > 5400 ? `${(p.seconds / 3600).toFixed(1)} ч` : p.seconds > 120 ? `${Math.round(p.seconds / 60)} мин` : `${p.seconds} с`} (подряд ошибок: ${p.fails})`);
  } else lines.push('', 'Пауз нет: все модели доступны.');
  return lines.join('\n');
}

// Названия чатов, которые бот ещё не успел запомнить из сообщений, берём у Telegram
export async function fillTitles() {
  for (const [id, st] of groups()) {
    if (st.title) continue;
    try {
      const c = await app.telegram.getChat(id);
      if (c?.title) st.title = c.title;
      st.chatType ||= c?.type;
    } catch {
      /* бота могли удалить из чата — оставляем «Чат id» */
    }
  }
  save();
}

// ---------- действия ----------
const sessions = new Map(); // id админа -> { say: chatId }

async function force(chatId, st, kind) {
  const before = (st.initLog || []).length;
  const today = dayKey(Date.now());
  if (kind === 'digest') return sendDigest(chatId, st);
  await runInitiative(chatId, st, kind, today);
  return (st.initLog || []).length > before;
}

const NO_TARGET = 'нет подходящего человека (нужны недавно писавшие и не отказавшиеся от подколов)';

async function bypass(ctx, text, kb) {
  try {
    await ctx.editMessageText(text, { reply_markup: kb });
  } catch (e) {
    if (!/not modified/i.test(e.message)) await ctx.reply(text, { reply_markup: kb });
  }
}

async function showCard(ctx, id, note = '') {
  const st = chat(id);
  const info = chatInfo(id, st);
  await bypass(ctx, cardText(info, note), cardKeyboard(info));
}

export async function onAction(ctx) {
  const from = ctx.from;
  if (!isAdmin(from) || ctx.chat?.type !== 'private') return ctx.answerCbQuery().catch(() => {}); // чужим не отвечаем
  const [, cmd, rawId, arg] = (ctx.callbackQuery?.data || '').split(':');
  const id = rawId != null ? Number(rawId) : null;
  const ack = (t, alert = false) => ctx.answerCbQuery(t, { show_alert: alert }).catch(() => {});

  try {
    if (cmd === 'm') { await ack(); const m = mainMenu(); return await bypass(ctx, m.text, m.kb); }
    if (cmd === 'l') { await ack(); await fillTitles(); const m = listMenu(); return await bypass(ctx, m.text, m.kb); }
    if (cmd === 'stk') {
      setSelfTalk(!selfTalk());
      await ack(selfTalk() ? 'Бот снова заговаривает сам' : 'Сам не пишет, только отвечает и кидает графики');
      const m = mainMenu();
      return await bypass(ctx, m.text, m.kb);
    }
    if (cmd === 'off') {
      setBotOff(!botOff());
      await ack(botOff() ? 'Бот выключен: молчит везде' : 'Бот включён');
      const m = mainMenu();
      return await bypass(ctx, m.text, m.kb);
    }
    if (cmd === 'os') {
      setOwnerSerious(!ownerSerious());
      await ack(ownerSerious() ? 'Со мной без шуток (если сам не попрошу)' : 'Со мной как со всеми');
      const m = mainMenu();
      return await bypass(ctx, m.text, m.kb);
    }
    if (cmd === 'ai') {
      await ack();
      return await bypass(ctx, aiText(aiStatus()), { inline_keyboard: [[btn('🔄 Обновить', 'a:ai'), btn('⬅️ Назад', 'a:m')]] });
    }
    if (id == null || !Number.isFinite(id) || id >= 0) return ack();
    const st = chat(id);
    const now = Date.now();

    switch (cmd) {
      case 'c':
        await ack();
        return await showCard(ctx, id);
      case 'rv':
      case 'nd':
      case 'pk':
      case 'tl':
      case 'dg': {
        const kind = { rv: 'revive', nd: 'needle', pk: 'poke', tl: 'tale', dg: 'digest' }[cmd];
        if (kind === 'needle' && !pickNeedleTarget(st, now)) return ack(`Подколоть некого: ${NO_TARGET}`, true);
        if (kind === 'poke' && !pickPokeTarget(st, now)) return ack('Звать некого: молчунов, которых давно не слышно, нет', true);
        await ack('Запускаю… (несколько секунд)');
        const ok = await force(id, st, kind);
        save();
        const names = { revive: 'Оживление', needle: 'Подкол с тегом', poke: 'Обращение к молчуну', tale: 'Байка', digest: 'Итоги дня' };
        return await showCard(ctx, id, ok ? `✅ ${names[kind]}: отправлено в чат.` : `⚠️ ${names[kind]}: не вышло (ИИ не ответил, всё слабое или мало материала). Попробуй ещё раз.`);
      }
      case 'mu':
        st.settings.mutedUntil = now + H;
        save();
        await ack('Тишина на час');
        return await showCard(ctx, id);
      case 'um':
        st.settings.mutedUntil = 0;
        save();
        await ack('Голос вернул');
        return await showCard(ctx, id);
      case 'ac': {
        const next = Math.min(5, Math.max(1, (st.settings.activity || 3) + (Number(arg) || 0)));
        st.settings.activity = next;
        save();
        await ack(`Активность ${next}`);
        return await showCard(ctx, id);
      }
      case 'hc':
        st.settings.hardcore = !st.settings.hardcore;
        save();
        await ack(st.settings.hardcore ? 'ХАРДКОР включён' : 'Хардкор выключен');
        return await showCard(ctx, id);
      case 'bm':
        setBotMode(st, NEXT[botMode(st)]);
        save();
        await ack(`Режим: ${MODES[botMode(st)]}`);
        return await showCard(ctx, id);
      case 'tn':
        st.settings.tone = TONE_NEXT[st.settings.tone || 'free'] || 'free';
        save();
        await ack(`Тон: ${TONES[st.settings.tone]}`);
        return await showCard(ctx, id);
      case 'cr':
        st.settings.crude = ((st.settings.crude ?? 3) + 1) % 4;
        save();
        await ack(`Пошлость ${st.settings.crude}`);
        return await showCard(ctx, id);
      case 'lf':
        st.settings.autonomy = st.settings.autonomy === false;
        save();
        await ack(st.settings.autonomy ? 'Своя жизнь включена' : 'Своя жизнь выключена');
        return await showCard(ctx, id);
      case 'st':
        await ack();
        return await ctx.reply(`📊 ${st.title || id}\n${statsText(st, now)}`);
      case 'sy':
        sessions.set(from.id, { say: id });
        await ack();
        return await ctx.reply(`✉️ Напиши одним сообщением текст, который бот отправит в «${st.title || id}».\nОтмена: /cancel`);
      case 'lv':
        await ack();
        return await bypass(ctx, `🚪 Точно выйти из «${st.title || id}»? Бот покинет чат, вернуть можно только повторным добавлением.`, {
          inline_keyboard: [[btn('Да, выйти', `a:lvy:${id}`), btn('Отмена', `a:c:${id}`)]],
        });
      case 'lvy':
        await ack();
        await app.telegram.leaveChat(id);
        console.log(`[admin] бот покинул чат ${id} по команде админа`);
        return await bypass(ctx, `Вышел из «${st.title || id}».`, { inline_keyboard: [[btn('⬅️ К списку', 'a:l')]] });
    }
    return ack();
  } catch (e) {
    console.error('[admin] ошибка действия:', e.message);
    return ack(`Ошибка: ${e.message}`.slice(0, 180), true);
  }
}

// Сообщения админа в личке: /admin и текст для «написать от имени бота». true — обработано.
export async function onAdminMessage(ctx) {
  const msg = ctx.message;
  if (ctx.chat?.type !== 'private' || !msg?.text) return false;
  const text = msg.text.trim();
  const isCmd = /^\/(?:admin|админ|панель|cancel|off|on|выкл|вкл)(?:@\w+)?$/iu.test(text);
  if (!isCmd && !sessions.has(msg.from.id)) return false; // обычный разговор — не наше дело
  if (!isAdmin(msg.from)) return false; // чужим не отвечаем особым образом: пойдёт как обычное сообщение

  if (/^\/cancel/i.test(text)) {
    sessions.delete(msg.from.id);
    await ctx.reply('Отменил.');
    return true;
  }
  if (/^\/(?:off|выкл)/iu.test(text) || /^\/(?:on|вкл)/iu.test(text)) {
    const off = /^\/(?:off|выкл)/iu.test(text);
    setBotOff(off);
    await ctx.reply(off ? '🔴 Бот выключен: молчу везде, сам ничего не делаю. Включить: /вкл' : '🟢 Бот включён.');
    return true;
  }
  if (isCmd) {
    sessions.delete(msg.from.id);
    await fillTitles();
    const m = mainMenu();
    await ctx.reply(m.text, { reply_markup: m.kb });
    return true;
  }
  const s = sessions.get(msg.from.id);
  if (s?.say != null) {
    sessions.delete(msg.from.id);
    if (text.startsWith('/')) {
      await ctx.reply('Команда не отправлена. Нажми «Написать от имени бота» ещё раз и пришли обычный текст.');
      return true;
    }
    const st = chat(s.say);
    try {
      await say(s.say, st, text.slice(0, 3500));
      save();
      await ctx.reply(`✅ Отправлено в «${st.title || s.say}».`);
    } catch (e) {
      await ctx.reply(`⚠️ Не удалось отправить: ${e.message}`);
    }
    return true;
  }
  return false;
}
