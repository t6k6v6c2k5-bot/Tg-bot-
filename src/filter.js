// Ступень 1: дешёвый фильтр без ИИ. Только чистые функции — легко тестировать.

export const LEVELS = {
  1: { p: 0.02, cap: 1 },
  2: { p: 0.04, cap: 2 },
  3: { p: 0.07, cap: 3 },
  4: { p: 0.12, cap: 5 },
  5: { p: 0.2, cap: 8 },
};

const W = (src) => new RegExp(`(?<!\\p{L})(?:${src})(?!\\p{L})`, 'iu');
const PREFIX = (src) => new RegExp(`(?<!\\p{L})(?:${src})`, 'iu');

// Серьёзные темы и накал: самопроизвольно не шутим
const SERIOUS = PREFIX(
  'умер|умерл|смерт|похорон|скончал|диагноз|онколог|больниц|операци|депресс|суицид|самоубий|развод|расстал|уволил|уволен|погиб|теракт|обстрел|' +
    'заткнись|иди нах|идиот|дебил|ненавижу',
);
// Политика и война: сам в такие разговоры не встреваю и не начинаю (прямой вопрос — другое дело)
const POLITICS = PREFIX(
  'крым|крим|донбасс|донбас|украин|україн|росси|рф\\b|война|войн[аыуеой]|вiйн|спецопер|сво\\b|всу\\b|путин|зеленск|навальн|мобилиз|санкци|политик|политич|выборы|выборов|оккупац|окупац|фронт|ракетн|обстрел|нато\\b|кремл|госдум|власти|режим',
);
const TRIGGER = W('скучно|скучаю|кто[- ]нибудь|есть кто|чем заняться|что делать|что посмотреть|кто здесь|все спят');
const LAUGH = PREFIX('а?ха(ха)+|лол|ору|ржу|😂|🤣|😆');
const WIN = W('круто|огонь|ура|победа|получилось|сдал|сдала|выиграл|выиграла');

export const UNSOL_MIN_GAP_MS = 3 * 60_000;
export const HOUR_MS = 3600_000;

const esc = (s) => s.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');

export function isDirect({ text, botUsername, aliases, replyToBot }) {
  if (replyToBot) return true;
  const low = text.toLowerCase();
  if (botUsername && low.includes('@' + botUsername.toLowerCase())) return true;
  return aliases.some((a) => W(`${esc(a)}\\p{L}{0,2}`).test(low));
}

export function isSerious(history, n = 6) {
  return history.slice(-n).some((m) => !m.bot && (SERIOUS.test(m.text) || POLITICS.test(m.text)));
}

// Можно ли боту вообще сказать что-то по своей инициативе
export function canSpeakUnsolicited(st, now) {
  if (st.settings.mutedUntil > now) return false;
  st.unsol = st.unsol.filter((t) => now - t < HOUR_MS);
  const { cap } = LEVELS[st.settings.activity];
  if (st.unsol.length >= cap) return false;
  if (now - st.lastUnsolAt < UNSOL_MIN_GAP_MS) return false;
  if (st.history.slice(-3).some((m) => m.bot)) return false; // только что говорили
  if (isSerious(st.history)) return false;
  return true;
}

// 'direct' | 'trigger' | 'random' | null
export function decide({ direct, text, st, now, rng = Math.random }) {
  if (st.settings.mutedUntil > now) return null;
  if (direct) return 'direct';
  if (!canSpeakUnsolicited(st, now)) return null;
  const { p } = LEVELS[st.settings.activity];
  if (TRIGGER.test(text)) return rng() < Math.min(0.5, p * 6) ? 'trigger' : null;
  return rng() < p ? 'random' : null;
}

// Бесплатная эмодзи-реакция без ИИ
export function cheapReaction({ text, st, now, rng = Math.random }) {
  if (st.settings.mutedUntil > now || now - st.lastReactAt < 90_000) return null;
  if (isSerious(st.history)) return null;
  const { p } = LEVELS[st.settings.activity];
  if (rng() >= p * 2.5) return null;
  if (LAUGH.test(text)) return '🤣';
  if (WIN.test(text)) return '🔥';
  return null;
}
