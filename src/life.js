import { config } from './config.js';
import { generate } from './ai.js';
import { parseReply } from './parse.js';
import { system, pokePrompt, greetingPrompt, talePrompt } from './prompts.js';
import { app, say } from './respond.js';
import { factsAbout } from './memory.js';
import { isSerious } from './filter.js';
import { sendRevive } from './commands.js';

// «Жизнь» Бати: он сам заговаривает, когда долго тихо, зовёт людей по имени,
// здоровается утром и травит байки. Всё в рамках предохранителей.

const H = 3600_000;
export const SILENCE_MS = { 2: 4 * H, 3: 2 * H, 4: 1.5 * H, 5: 0.75 * H };
export const DAILY_CAP = { 1: 0, 2: 2, 3: 4, 4: 6, 5: 10 };
const MIN_GAP_MS = 45 * 60_000;
const POKE_PER_PERSON_MS = 24 * H;

export function isQuietHour(hour, from = config.quietFrom, to = config.quietTo) {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

const lastHumanTs = (st) => [...st.history].reverse().find((m) => !m.bot)?.ts ?? 0;

export function lastSeen(st) {
  const seen = {};
  for (const m of st.history) if (!m.bot && m.uid) seen[m.uid] = m.ts;
  return seen;
}

// Кого можно позвать: давно молчит (5 ч – 7 дней), недавно не звали
export function pickPokeTarget(st, now, rng = Math.random) {
  const seen = lastSeen(st);
  const pool = Object.entries(seen).filter(([uid, ts]) => {
    const quiet = now - ts;
    return quiet >= 5 * H && quiet <= 7 * 24 * H && now - (st.pokeLast?.[uid] || 0) >= POKE_PER_PERSON_MS && st.users[uid];
  });
  if (!pool.length) return null;
  // у кого в памяти есть что вспомнить — тот вероятнее
  const weighted = pool.flatMap(([uid, ts]) => Array(1 + Math.min(2, factsAbout(st, uid).length)).fill([uid, ts]));
  const [uid, ts] = weighted[Math.floor(rng() * weighted.length)];
  return { uid, quietHours: Math.round((now - ts) / H) };
}

/**
 * Решает, пора ли Бате проявить инициативу. Чистая функция.
 * @returns {'greeting'|'revive'|'poke'|'tale'|null}
 */
export function pickInitiative(st, now, { hour, today, rng = Math.random }) {
  const s = st.settings;
  if (s.autonomy === false || s.mutedUntil > now) return null;
  if (isQuietHour(hour)) return null;
  const cap = DAILY_CAP[s.activity] ?? 0;
  st.initLog = (st.initLog || []).filter((t) => now - t < 24 * H);
  if (!cap || st.initLog.length >= cap) return null;
  if ((st.ignored || 0) >= 2) return null; // чат дважды проигнорировал — ждём, пока кто-то заговорит
  if (now - Math.max(st.lastInitAt || 0, st.initTryAt || 0) < MIN_GAP_MS) return null;
  if (isSerious(st.history)) return null;

  const human = lastHumanTs(st);
  if (!human || now - human > 3 * 24 * H || st.history.length < 15) return null; // чат неживой
  if (rng() > 0.25) return null; // джиттер: не в первую же минуту

  if (hour >= config.wakeHour && hour < config.wakeHour + 2 && st.lastGreetDay !== today && now - human < 2 * 24 * H) return 'greeting';

  if (now - human < (SILENCE_MS[s.activity] ?? 2 * H)) return null; // ещё болтают

  const options = [];
  if (now - (st.lastReviveAt || 0) > 5 * H) options.push(['revive', 3]);
  if (pickPokeTarget(st, now, () => 0)) options.push(['poke', 3]);
  if (now - (st.lastTaleAt || 0) > 20 * H) options.push(['tale', 1]);
  if (!options.length) return null;
  let r = rng() * options.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of options) if ((r -= w) < 0) return k;
  return options[0][0];
}

async function speak(chatId, st, text) {
  const sent = await say(chatId, st, text);
  const now = Date.now();
  st.initLog = [...(st.initLog || []), now];
  st.lastInitAt = now;
  st.lastUnsolAt = now;
  st.initOpen = true;
  return sent;
}

const ask = (st, prompt, maxTokens = 180) =>
  generate({ system: system(st, app.name), prompt, maxTokens, temperature: 1 });

export async function runInitiative(chatId, st, kind, today) {
  const now = Date.now();
  st.initTryAt = now;
  console.log(`[life] chat=${chatId} инициатива: ${kind}`);

  if (kind === 'revive') {
    if (await sendRevive(chatId, st)) {
      st.initLog = [...(st.initLog || []), now];
      st.lastInitAt = now;
      st.lastUnsolAt = now;
      st.initOpen = true;
    } else st.lastReviveAt = now;
    return;
  }

  if (kind === 'greeting') {
    st.lastGreetDay = today;
    const res = await ask(st, greetingPrompt(st.history), 120);
    const r = res && parseReply(res.text);
    if (r?.type === 'text') await speak(chatId, st, r.text);
    return;
  }

  if (kind === 'tale') {
    st.lastTaleAt = now;
    const res = await ask(st, talePrompt(st.history), 220);
    const r = res && parseReply(res.text, { maxLines: 4, maxChars: 500 });
    if (r?.type === 'text') await speak(chatId, st, r.text);
    return;
  }

  if (kind === 'poke') {
    const target = pickPokeTarget(st, now);
    if (!target) return;
    const u = st.users[target.uid];
    st.pokeLast = { ...(st.pokeLast || {}), [target.uid]: now };
    const lines = st.history.filter((m) => !m.bot && String(m.uid) === String(target.uid)).slice(-3).map((m) => m.text);
    const handle = u.username ? `@${u.username}` : '';
    const res = await ask(
      st,
      pokePrompt({ name: u.name, handle, facts: factsAbout(st, target.uid).slice(-4), lines, quietHours: target.quietHours, history: st.history }),
    );
    const r = res && parseReply(res.text);
    if (r?.type !== 'text') return;
    // чтобы человеку пришло уведомление, обращение по @нику должно быть в тексте
    const text = handle && !r.text.toLowerCase().includes(handle.toLowerCase()) ? `${handle}, ${r.text}` : r.text;
    await speak(chatId, st, text);
  }
}

// Любое сообщение человека гасит режим «меня проигнорировали»
export function onHumanMessage(st) {
  st.initOpen = false;
  st.ignored = 0;
}

// Раз в тик: если инициатива висит без реакции больше 2 часов — это игнор
export function trackIgnore(st, now) {
  if (st.initOpen && now - (st.lastInitAt || 0) > 2 * H) {
    st.initOpen = false;
    st.ignored = (st.ignored || 0) + 1;
    console.log(`[life] инициатива без реакции, подряд: ${st.ignored}`);
  }
}
