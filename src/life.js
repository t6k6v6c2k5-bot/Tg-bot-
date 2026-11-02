import { config } from './config.js';
import { generate } from './ai.js';
import { parseReply } from './parse.js';
import { system, pokePrompt, needlePrompt, greetingPrompt, talePrompt, transcript } from './prompts.js';
import { bestOf } from './wit.js';
import { logSay } from './log.js';
import { pickAngle, repetition } from './variety.js';
import { bodyJokeAboutPerson } from './safety.js';
import { app, say } from './respond.js';
import { factsAbout } from './memory.js';
import { isSerious } from './filter.js';
import { sendRevive } from './commands.js';

// «Жизнь» Бати: он сам заговаривает, когда долго тихо, зовёт людей по имени,
// здоровается утром и травит байки. Всё в рамках предохранителей.

const H = 3600_000;
// Потолок инициатив в сутки по уровню /активность; реальный бюджет — от 40% до 100% потолка
// в зависимости от того, как чат реагирует на Батю (см. dailyCap).
export const CEILING = { 1: 0, 2: 3, 3: 6, 4: 8, 5: 10 };
// Резервные пороги тишины, пока в чате мало истории
export const SILENCE_MS = { 2: 4 * H, 3: 2 * H, 4: 1.5 * H, 5: 0.75 * H };
const SILENCE_SCALE = { 2: 1.6, 3: 1, 4: 0.75, 5: 0.5 };
const POKE_PER_PERSON_MS = 24 * H;
const KINDS = ['revive', 'poke', 'tale'];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---- обучение на реакции чата ----
// score: 1 — ответили Бате, 0.8 — быстро заговорили, 0.2 — заметили поздно, 0 — игнор
export function recordOutcome(st, kind, score) {
  const a = 0.3;
  st.engage = st.engage == null ? 0.5 * (1 - a) + score * a : st.engage * (1 - a) + score * a;
  st.kindStats ||= {};
  const k = (st.kindStats[kind] ||= { n: 0, ema: 0.5 });
  k.ema = k.ema * (1 - a) + score * a;
  k.n++;
}

export const engagement = (st) => st.engage ?? 0.5;

// Сколько инициатив Батя позволяет себе за сутки: 4 при глухом чате, 10 при отзывчивом (на уровне 5)
export function dailyCap(st) {
  const ceil = CEILING[st.settings.activity] ?? 0;
  if (!ceil) return 0;
  return Math.max(1, Math.round(ceil * clamp(0.4 + engagement(st), 0.4, 1)));
}

// ---- «когда в этом чате вообще живут» ----
const histTotal = (st) => (st.hourHist || []).reduce((a, b) => a + b, 0);
const HIST_MIN = 150;

export function noteHour(st, hour) {
  const h = (st.hourHist ||= Array(24).fill(0));
  h[hour]++;
  if (histTotal(st) > 3000) st.hourHist = h.map((x) => Math.floor(x / 2)); // старое постепенно забывается
}

export function isAwake(st, hour) {
  if (histTotal(st) < HIST_MIN) return !isQuietHour(hour);
  return st.hourHist[hour] >= 0.08 * Math.max(...st.hourHist);
}

// Во сколько в этом чате начинается день (для приветствия)
export function wakeHourFor(st) {
  if (histTotal(st) < HIST_MIN) return config.wakeHour;
  const max = Math.max(...st.hourHist);
  for (let h = 5; h < 14; h++) if (st.hourHist[h] >= 0.2 * max) return h;
  return config.wakeHour;
}

// Какая тишина для ЭТОГО чата необычна: ~4 типичных паузы между сообщениями
export function silenceThreshold(st) {
  const gaps = [];
  let prev = null;
  for (const m of st.history) {
    if (m.bot) continue;
    if (prev && m.ts - prev < 6 * H) gaps.push(m.ts - prev);
    prev = m.ts;
  }
  const level = st.settings.activity;
  if (gaps.length < 30) return SILENCE_MS[level] ?? 2 * H;
  gaps.sort((x, y) => x - y);
  const median = gaps[Math.floor(gaps.length / 2)];
  return clamp(median * 4 * (SILENCE_SCALE[level] ?? 1), 30 * 60_000, 5 * H);
}

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

const WEEK = 7 * 24 * H;

// Кого можно «зацепить»: недавно писал (материал есть), не в списке «не подкалывать»,
// не просил отстать, по своей инициативе не цеплялись за него сутки
export function pickNeedleTarget(st, now, rng = Math.random) {
  const seen = lastSeen(st);
  const counts = {};
  for (const m of st.history.slice(-600)) if (!m.bot && m.uid && now - m.ts < 3 * 24 * H) counts[m.uid] = (counts[m.uid] || 0) + 1;
  const pool = Object.entries(seen).filter(
    ([uid, ts]) =>
      st.users[uid] &&
      !st.optOut?.[uid] &&
      !(st.leaveAlone?.[uid] > now - WEEK) &&
      now - ts < 3 * 24 * H &&
      (counts[uid] || 0) >= 3 &&
      now - (st.needleLast?.[uid] || 0) >= 24 * H &&
      now - (st.roastLast?.[uid] || 0) >= config.roastCooldownMs,
  );
  if (!pool.length) return null;
  const [uid] = pool[Math.floor(rng() * pool.length)];
  return { uid };
}

// После «@ник, » первая буква строчная («@vanya, в понедельник…»), кроме аббревиатур и имени самого адресата
function lowerFirst(t, name = '') {
  const w = t.match(/^[\p{L}\d]+/u)?.[0];
  if (!w || (w.length > 1 && w === w.toUpperCase()) || /\d/.test(w) || (name && w.toLowerCase() === name.toLowerCase())) return t;
  return t[0].toLowerCase() + t.slice(1);
}

// Тег человека: по @нику, а без ника — через text_mention (уведомление придёт всё равно)
export function withMention(u, uid, text) {
  if (u.username) {
    const h = '@' + u.username;
    return { text: text.toLowerCase().includes(h.toLowerCase()) ? text : `${h}, ${lowerFirst(text, u.name)}` };
  }
  const name = u.name;
  const full = text.startsWith(name) ? text : `${name}, ${lowerFirst(text, name)}`;
  return { text: full, entities: [{ type: 'text_mention', offset: 0, length: name.length, user: { id: Number(uid) } }] };
}

/**
 * Решает, пора ли Бате проявить инициативу. Чистая функция.
 * @returns {'greeting'|'revive'|'poke'|'tale'|null}
 */
export function pickInitiative(st, now, { hour, today, rng = Math.random }) {
  const s = st.settings;
  if (s.autonomy === false || s.mutedUntil > now) return null;
  if (!isAwake(st, hour)) return null;
  const cap = dailyCap(st);
  st.initLog = (st.initLog || []).filter((t) => now - t < 24 * H);
  if (!cap || st.initLog.length >= cap) return null;
  if ((st.ignored || 0) >= 2) return null; // чат дважды проигнорировал — ждём, пока кто-то заговорит
  // после удачной инициативы можно скорее, после проигнорированной — подождать
  const gap = (st.ignored || 0) >= 1 ? 90 * 60_000 : engagement(st) > 0.6 ? 30 * 60_000 : 45 * 60_000;
  if (now - Math.max(st.lastInitAt || 0, st.initTryAt || 0) < gap) return null;
  if (isSerious(st.history)) return null;

  const human = lastHumanTs(st);
  if (!human || now - human > 3 * 24 * H || st.history.length < 15) return null; // чат неживой
  if (rng() > 0.25) return null; // джиттер: не в первую же минуту

  const wake = wakeHourFor(st);
  if (hour >= wake && hour < wake + 2 && st.lastGreetDay !== today && now - human < 2 * 24 * H) return 'greeting';

  if (now - human < silenceThreshold(st)) return null; // ещё болтают или тишина обычная

  const options = [];
  if (now - (st.lastReviveAt || 0) > 5 * H) options.push('revive');
  if (pickPokeTarget(st, now, () => 0)) options.push('poke');
  if (now - (st.lastTaleAt || 0) > 20 * H) options.push('tale');
  // дерзкий подкол с тегом: не на мягком тоне, не чаще раза в 4 часа
  if (s.tone !== 'soft' && s.activity >= 3 && now - (st.lastNeedleAt || 0) > 4 * H && pickNeedleTarget(st, now, () => 0)) options.push('needle');
  if (!options.length) return null;
  // чаще то, на что в этом чате откликаются
  const weight = (k) => ({ tale: 1, needle: 2 }[k] ?? 3) * (0.5 + (st.kindStats?.[k]?.ema ?? 0.5));
  let r = rng() * options.reduce((a, k) => a + weight(k), 0);
  for (const k of options) if ((r -= weight(k)) < 0) return k;
  return options[0];
}

async function speak(chatId, st, text, kind, angle, entities) {
  logSay({ kind: `инициатива:${kind}`, angle: angle?.id, question: '', answer: text });
  const sent = await say(chatId, st, text, undefined, { angle: angle?.id, entities });
  const now = Date.now();
  st.initLog = [...(st.initLog || []), now];
  st.lastInitAt = now;
  st.lastUnsolAt = now;
  st.initOpen = true;
  st.initKind = kind;
  return sent;
}

// Инициатива: несколько вариантов, редактор выбирает лучший; если все слабые — молчим
async function ask(st, prompt, maxTokens = 180, opts) {
  const angle = pickAngle(st);
  const res = await bestOf({
    system: system(st, app.name, { angle }),
    prompt,
    context: transcript(st.history, 6),
    direct: false,
    reject: (t) => bodyJokeAboutPerson(t, st) || repetition(t, st).length > 0,
    maxTokens: Math.round(maxTokens / 2),
    parseOpts: opts,
  });
  if (!res) return null;
  const r = parseReply(res.text, opts);
  return r.type === 'text' ? { ...r, angle } : null;
}

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
      st.initKind = 'revive';
    } else st.lastReviveAt = now;
    return;
  }

  if (kind === 'greeting') {
    st.lastGreetDay = today;
    const r = await ask(st, greetingPrompt(st.history), 120);
    if (r?.type === 'text') await speak(chatId, st, r.text, 'greeting', r.angle);
    return;
  }

  if (kind === 'tale') {
    st.lastTaleAt = now;
    const r = await ask(st, talePrompt(st.history), 220, { maxLines: 4, maxChars: 500 });
    if (r?.type === 'text') await speak(chatId, st, r.text, 'tale', r.angle);
    return;
  }

  if (kind === 'poke') {
    const target = pickPokeTarget(st, now);
    if (!target) return;
    const u = st.users[target.uid];
    st.pokeLast = { ...(st.pokeLast || {}), [target.uid]: now };
    const lines = st.history.filter((m) => !m.bot && String(m.uid) === String(target.uid)).slice(-3).map((m) => m.text);
    const handle = u.username ? `@${u.username}` : '';
    const r = await ask(
      st,
      pokePrompt({ name: u.name, handle, facts: factsAbout(st, target.uid).slice(-4), lines, quietHours: target.quietHours, history: st.history }),
    );
    if (r?.type !== 'text') return;
    // чтобы человеку пришло уведомление, он должен быть тегнут
    const m = withMention(u, target.uid, r.text);
    await speak(chatId, st, m.text, 'poke', r.angle, m.entities);
    return;
  }

  if (kind === 'needle') {
    const target = pickNeedleTarget(st, now);
    if (!target) return;
    const u = st.users[target.uid];
    // фиксируем попытку сразу: даже если ИИ промолчит, за этого человека не цепляемся сутки
    st.needleLast = { ...(st.needleLast || {}), [target.uid]: now };
    st.lastNeedleAt = now;
    const lines = st.history.filter((m) => !m.bot && String(m.uid) === String(target.uid) && now - m.ts < 3 * 24 * H).slice(-6).map((m) => m.text);
    const handle = u.username ? `@${u.username}` : '';
    const r = await ask(st, needlePrompt({ name: u.name, handle, facts: factsAbout(st, target.uid).slice(-4), lines, history: st.history }), 160);
    if (r?.type !== 'text') return;
    st.roastLast[target.uid] = now;
    const m = withMention(u, target.uid, r.text);
    await speak(chatId, st, m.text, 'needle', r.angle, m.entities);
  }
}

// Человек написал: учимся, откликнулись ли на последнюю инициативу
export function onHumanMessage(st, now = Date.now(), replyToBot = false) {
  if (st.initOpen) {
    const fast = now - (st.lastInitAt || 0) < 30 * 60_000;
    recordOutcome(st, st.initKind || 'revive', replyToBot ? 1 : fast ? 0.8 : 0.2);
    st.initOpen = false;
  }
  st.ignored = 0;
}

// Раз в тик: если инициатива висит без реакции больше 2 часов — это игнор
export function trackIgnore(st, now) {
  if (st.initOpen && now - (st.lastInitAt || 0) > 2 * H) {
    st.initOpen = false;
    st.ignored = (st.ignored || 0) + 1;
    recordOutcome(st, st.initKind || 'revive', 0);
    console.log(`[life] инициатива без реакции, подряд: ${st.ignored}; отзывчивость ${engagement(st).toFixed(2)}, бюджет ${dailyCap(st)}/сут`);
  }
}

export function lifeStatus(st) {
  const left = Math.max(0, dailyCap(st) - (st.initLog || []).filter((t) => Date.now() - t < 24 * H).length);
  return `Сейчас могу написать сам ещё до ${left} раз за ближайшие сутки (бюджет ${dailyCap(st)}: чат отзывается на меня на ${Math.round(engagement(st) * 100)}%). Тишина, после которой я заговорю: ~${Math.round(silenceThreshold(st) / 60_000)} мин.`;
}
