import { config } from './config.js';
import { generate } from './ai.js';
import { parseReply } from './parse.js';
import { system, chatPrompt, roastPrompt } from './prompts.js';
import { remember } from './store.js';
import { factsAbout } from './memory.js';
import { analysisContext } from './analysis.js';
import { pickAngle, repetition, trimEmoji, exchangeLength } from './variety.js';
import { bestOf } from './wit.js';
import { logSay } from './log.js';
import { transcript } from './prompts.js';
import { bodyJokeAboutPerson, bodyRequestNote, REFUSALS, DECLINES, NO_IDEAS, pickLine } from './safety.js';

export const app = { telegram: null, username: '', id: 0, name: 'Бот' };

const busy = new Set(); // не больше одного ИИ-запроса на чат одновременно
const esc = (s) => s.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');

const nameRe = (n) => new RegExp(`(?<!\\p{L})${esc(n)}(?!\\p{L})`, 'iu');

// Кого из участников упомянули в тексте (по имени или @нику)
export function mentionedUsers(st, text) {
  const out = [];
  for (const [uid, u] of Object.entries(st.users)) {
    const hit =
      (u.name && u.name.length >= 2 && nameRe(u.name).test(text)) ||
      (u.username && text.toLowerCase().includes('@' + u.username.toLowerCase()));
    if (hit) out.push(uid);
  }
  return out;
}

export async function say(chatId, st, text, replyTo, meta = {}) {
  const { entities, ...rest } = meta;
  const base = { reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined };
  let sent;
  try {
    // entities (text_mention) нужны, чтобы тегнуть человека без @ника: ему придёт уведомление
    sent = await app.telegram.sendMessage(chatId, text, entities ? { ...base, entities } : base);
  } catch (e) {
    if (!entities) throw e;
    console.warn('[say] не удалось с тегом, отправляю без него:', e.message);
    sent = await app.telegram.sendMessage(chatId, text, base);
  }
  remember(st, { id: sent.message_id, uid: app.id, name: app.name, text, ts: Date.now(), bot: true, ...rest });
  if (rest.angle) st.lastAngle = rest.angle;
  return sent;
}

export async function react(chatId, messageId, emoji) {
  try {
    await app.telegram.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]);
    return true;
  } catch (e) {
    console.warn('[react]', e.message);
    return false;
  }
}

// Ступень 2: идём в ИИ, он может ответить SKIP
export async function respond(chatId, st, { mode, replyTo }) {
  if (busy.has(chatId)) {
    console.log(`[${mode}] чат занят, пропуск`);
    return false;
  }
  busy.add(chatId);
  try {
    const direct = mode === 'direct' || mode === 'critic';
    const angle = pickAngle(st);
    const lastText = st.history[st.history.length - 1]?.text || '';
    const dataBlock = direct ? [analysisContext(st, lastText), bodyRequestNote(lastText, st)].filter(Boolean).join('\n\n') : '';
    // Затянувшийся обмен с одним человеком: сначала ставим точку одной фразой, потом просто не продолжаем
    const chain = direct ? exchangeLength(st) : 0;
    if (chain >= 5) {  // после фразы-точки просто не продолжаем
      console.log(`[${mode}] обмен затянулся (${chain}), только реакция`);
      if (replyTo && (await react(chatId, replyTo, '🤝'))) return true;
      return false;
    }
    const endNote = chain >= 3 ? `\n\nВНИМАНИЕ: вы с этим человеком уже обменялись ${chain} репликами подряд. Заверши обмен ОДНОЙ короткой фразой-точкой с юмором. Формат REACT здесь запрещён, SKIP тоже: нужна именно текстовая реплика. Не разгоняй разговор дальше и не задавай встречных вопросов.` : '';
    const prompt = chatPrompt(st.history, mode, direct ? 30 : config.historyInPrompt, dataBlock) + endNote;
    // Остроумие: без блока данных (аналитика, пересказы) — пишем варианты и выбираем лучший
    const useWit = !dataBlock && mode !== 'critic';
    const popts = direct ? { maxLines: 6, maxChars: 800 } : undefined;
    const ask = (banned = []) =>
      useWit
        ? bestOf({
            system: system(st, app.name, { long: direct, angle, banned }),
            prompt,
            context: transcript(st.history, 8),
            direct,
            reject: (t) => bodyJokeAboutPerson(t, st) || repetition(t, st).length > 0,
            tier: direct ? 'smart' : 'fast',
            high: direct,
            maxTokens: direct ? 160 : 70,
            parseOpts: popts,
          })
        : generate({
            system: system(st, app.name, { long: direct, angle, banned }),
            prompt,
            maxTokens: direct ? 500 : 100,
            high: direct,
            tier: direct ? 'smart' : 'fast',
          });
    let res = await ask();
    if (!res) {
      console.log(`[${mode}] ИИ не ответил`);
      const now = Date.now();
      if (direct && now - (st.lastErrAt || 0) > 2 * 60_000) {
        st.lastErrAt = now;
        await say(chatId, st, 'Что-то я приболел, мозги не включаются. Спроси чуть позже 🤒', replyTo);
      }
      return false;
    }
    let r = parseReply(res.text, popts);
    if (chain >= 3 && r.type === 'react') {
      const again = await ask(['реакция вместо текста: здесь нужна короткая текстовая фраза-точка']);
      const ra = again ? parseReply(again.text, popts) : r;
      if (ra.type === 'text') r = ra;
    }
    console.log(`[${mode}] ${res.provider} -> ${r.type} (${angle.id})${res.weak ? ' [редактор: всё слабо]' : ''}${res.pick ? ` [выбран ${res.pick}]` : ''}`);
    if (r.type === 'text' && bodyJokeAboutPerson(r.text, st)) {
      console.log(`[${mode}] шутка про тело/интим участника — перегенерирую`);
      const res3 = await ask(['шутки про тело, внешность и интимную жизнь людей из чата']);
      const r3 = res3 ? parseReply(res3.text, popts) : { type: 'skip' };
      if (r3.type === 'text' && !bodyJokeAboutPerson(r3.text, st)) r = r3;
      else if (direct) r = { type: 'text', text: pickLine(REFUSALS) };
      else return false;
    }
    if (r.type === 'text') {
      const bad = repetition(r.text, st);
      if (bad.length) {
        console.log(`[${mode}] повтор: ${bad.join(', ')} — перегенерирую`);
        const res2 = await ask(bad);
        const r2 = res2 ? parseReply(res2.text, popts) : { type: 'skip' };
        if (r2.type === 'text' && !repetition(r2.text, st).length) r = r2;
        else if (!direct) return false; // сам вклиниваться с повтором не стоит
      }
    }
    // Настоящий отказ по несдвигаемым линиям: бот сам формулирует короткую фразу
    if (r.type === 'refuse') {
      console.log(`[${mode}] REFUSE (${res.provider})`);
      if (!direct || !replyTo) return false;
      logSay({ kind: mode + ':REFUSE', provider: res.provider, question: lastText, answer: r.text });
      await say(chatId, st, r.text || pickLine(DECLINES), replyTo);
      return true;
    }
    if (r.type === 'skip' && direct) {
      // Человек обратился напрямую: молчать нельзя, и «не придумал» — не отказ.
      // Пробуем ещё раз попроще (один вариант, без отбора шуток), потом честно говорим, что мысль не идёт.
      console.log(`[${mode}] SKIP на прямое обращение (${res.provider}) — пробую попроще`);
      const plain = await generate({
        system: system(st, app.name, { long: true, angle }),
        prompt: prompt + '\n\nОтветь по-простому и по делу, одной-двумя фразами, без отказа и без SKIP. Если просят что-то рассказать, расскажи короткую шутку или забавный факт.',
        maxTokens: 220,
        high: true,
        tier: 'smart',
      });
      const rp = plain ? parseReply(plain.text, popts) : { type: 'skip' };
      if (rp.type === 'text') r = rp;
      else if (rp.type === 'refuse') {
        if (replyTo) await say(chatId, st, rp.text || pickLine(DECLINES), replyTo);
        return true;
      } else {
        if (replyTo && Date.now() - (st.lastDeclineAt || 0) > 60_000) {
          st.lastDeclineAt = Date.now();
          logSay({ kind: mode + ':нет-идей', question: lastText, answer: '(стандартная фраза «мысль не идёт»)' });
          await say(chatId, st, pickLine(NO_IDEAS), replyTo);
          return true;
        }
        return false;
      }
    }
    if (r.type === 'skip') {
      console.log(`[${mode}] SKIP (${res.provider})`);
      return false;
    }
    const now = Date.now();
    if (r.type === 'text' && !direct) {
      // защита от подкола неприкосновенных и частых подколов
      const named = mentionedUsers(st, r.text);
      if (named.some((u) => st.optOut[u] || now - (st.roastLast[u] || 0) < config.roastCooldownMs)) {
        console.log(`[${mode}] отброшено: упомянут защищённый/недавно задетый`);
        return false;
      }
      for (const u of named) st.roastLast[u] = now;
    }
    if (r.type === 'react') {
      if (!replyTo || !(await react(chatId, replyTo, r.emoji))) return false;
      st.lastReactAt = now;
    } else {
      const finalText = trimEmoji(r.text, st);
      logSay({ kind: mode, angle: angle.id, provider: res.provider, question: lastText, answer: finalText });
      await say(chatId, st, finalText, replyTo, { angle: angle.id });
    }
    if (!direct) {
      st.unsol.push(now);
      st.lastUnsolAt = now;
    }
    return true;
  } catch (e) {
    console.error('[respond]', e.message);
    return false;
  } finally {
    busy.delete(chatId);
  }
}

// /прожарь — Grok первым, Gemini как запасной
export async function roast(chatId, st, { targetUid, askedBy, replyTo }) {
  const target = st.users[targetUid];
  const lines = st.history.filter((m) => !m.bot && String(m.uid) === String(targetUid)).slice(-10).map((m) => m.text);
  const res = await generate({
    system: system(st, app.name),
    prompt: roastPrompt(target.name, lines, askedBy, factsAbout(st, targetUid).slice(-4)),
    prefer: 'edgy',
    temperature: 1,
    maxTokens: 100,
    high: true,
  });
  const r = res ? parseReply(res.text) : { type: 'skip' };
  if (r.type !== 'text') {
    await say(chatId, st, 'Не за что зацепиться — сегодня тебе повезло 😌', replyTo);
    return;
  }
  st.roastLast[targetUid] = Date.now();
  await say(chatId, st, r.text, replyTo);
}
