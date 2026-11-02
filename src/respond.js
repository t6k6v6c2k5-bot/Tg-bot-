import { config } from './config.js';
import { generate } from './ai.js';
import { parseReply } from './parse.js';
import { system, chatPrompt, roastPrompt } from './prompts.js';
import { remember } from './store.js';
import { factsAbout } from './memory.js';

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

export async function say(chatId, st, text, replyTo) {
  const sent = await app.telegram.sendMessage(chatId, text, {
    reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined,
  });
  remember(st, { id: sent.message_id, uid: app.id, name: app.name, text, ts: Date.now(), bot: true });
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
    const direct = mode === 'direct';
    const res = await generate({
      system: system(st, app.name, { long: direct }),
      prompt: chatPrompt(st.history, mode, direct ? 30 : config.historyInPrompt),
      maxTokens: direct ? 450 : 100,
      high: direct,
      tier: direct ? 'smart' : 'fast',
    });
    if (!res) {
      console.log(`[${mode}] ИИ не ответил`);
      const now = Date.now();
      if (direct && now - (st.lastErrAt || 0) > 2 * 60_000) {
        st.lastErrAt = now;
        await say(chatId, st, 'Что-то я приболел, мозги не включаются. Спроси чуть позже 🤒', replyTo);
      }
      return false;
    }
    const r = parseReply(res.text, direct ? { maxLines: 6, maxChars: 800 } : undefined);
    console.log(`[${mode}] ${res.provider} -> ${r.type}`);
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
      await say(chatId, st, r.text, replyTo);
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
