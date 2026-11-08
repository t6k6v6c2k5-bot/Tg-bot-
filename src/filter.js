// Ступень 1: дешёвый фильтр без ИИ. Только чистые функции — легко тестировать.
import { effActivity } from './botmode.js';

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
const TRIGGER = W('скучно|скучаю|кто[- ]нибудь|есть кто|чем заняться|что делать|что посмотреть|кто здесь|все спят');
export const LAUGH = PREFIX('а?ха(ха)+|лол|ору|ржу|😂|🤣|😆');
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
  return history.slice(-n).some((m) => !m.bot && SERIOUS.test(m.text));
}

// Можно ли боту вообще сказать что-то по своей инициативе
export function canSpeakUnsolicited(st, now) {
  if (st.settings.mutedUntil > now) return false;
  st.unsol = st.unsol.filter((t) => now - t < HOUR_MS);
  const { cap } = LEVELS[effActivity(st)];
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
  const { p } = LEVELS[effActivity(st)];
  if (TRIGGER.test(text)) return rng() < Math.min(0.5, p * 6) ? 'trigger' : null;
  return rng() < p ? 'random' : null;
}

// Бесплатная эмодзи-реакция без ИИ
export function cheapReaction({ text, st, now, rng = Math.random }) {
  if (st.settings.mutedUntil > now || now - st.lastReactAt < 90_000) return null;
  if (isSerious(st.history)) return null;
  const { p } = LEVELS[effActivity(st)];
  if (rng() >= p * 2.5) return null;
  if (LAUGH.test(text)) return '🤣';
  if (WIN.test(text)) return '🔥';
  return null;
}

// Реплика-«точка»: человек подтверждает, благодарит или смеётся. Отвечать на неё не нужно —
// иначе бот выдаёт «ещё одну остроту» там, где разговор уже закончен.
const CLOSER_ACK = /^(?:ок(?:ей|ейно)?|окей|ладно|ну\s+ладно|понял[аи]?|понятно|ясно|ясненько|ясн|принял[аи]?|принято|збс|зашибись|заебись|супер|класс|круто|норм|нормально|отлично|хорошо|ага|угу|да|ну\s+да|точно|согласен|согласна|верно|не\s+вопрос|договорились|вопросов\s+нет)$/iu;
const CLOSER_PRAISE = /^(?:ты\s+)?(?:харош|хорош|красав\p{L}*|молодец|молодчин\p{L}*|топ|топчик|мощно|сильно|жиза|жиз|респект|уважаю|огонь|бомба|класс\p{L}*|имба|годно|ржака|смешно|смешн\p{L}*|умничка|хорош\s+шутк\p{L}*|ну\s+ты\s+даёшь)$/iu;
const CLOSER_THANKS = /^(?:спс|спасибо|пасиб|благодарю|благодарствую|мерси|дякую|сенкс|thx|thanks)(?:\s+(?:большое|тебе|бать|батя))?$/iu;
const CLOSER_LAUGH = /^(?:а?ха(?:ха)+\p{L}*|ха|хех|лол|ору|ржу|ахах\p{L}*|\)+|😂|🤣|😁|😆|😄|😀|хд)$/iu;
const CLOSER_EMOJI = /^(?:[👍👌🙏✅🫡🤝❤🔥👏💪🙂😊]+)$/u;

/** @returns {'ack'|'thanks'|'praise'|'laugh'|'emoji'|null} */
export function closerKind(text) {
  const t = (text || '')
    .toLowerCase()
    .replace(/(?:батя|бать|бот)[,!\s]*/giu, '') // обращение не меняет смысла
    .replace(/[!.,…\s]+$/u, '')
    .replace(/^[,.\s]+/u, '')
    .trim();
  if (!t || t.length > 24 || t.includes('?')) return null;
  if (CLOSER_THANKS.test(t)) return 'thanks';
  if (CLOSER_PRAISE.test(t.replace(/^да\s+/u, ''))) return 'praise';
  if (CLOSER_LAUGH.test(t)) return 'laugh';
  if (CLOSER_EMOJI.test(t.replace(/\uFE0F/g, ''))) return 'emoji';
  if (CLOSER_ACK.test(t)) return 'ack';
  return null;
}

/** Человек просит ответить серьёзно: «без подколов», «без шуток», «по делу», «серьёзно». */
export const wantsSerious = (text) => /(?<!\p{L})(?:без\s+(?:подкол\p{L}*|шуток|юмора|приколов|стёба|стеба|сарказма|иронии)|серьёзно|серьезно|по\s+делу|по\s+сути|не\s+шути|хватит\s+шутить|давай\s+серьёзно)(?!\p{L})/iu.test(text || '');

/** Человек сам просит пошутить/подколоть. */
export const wantsJoke = (text) => /(?<!\p{L})(?:пошути|пошутить|шутк\p{L}*|анекдот\p{L}*|подколи|подкол\p{L}*|прожарь|рассмеши|рофл\p{L}*|поприкалывайся|посмеши)(?!\p{L})/iu.test(text || '') && !wantsSerious(text);

/** Вопрос про то, какая модель/версия ИИ используется. */
export const isModelQuestion = (text) => {
  const t = text || '';
  return (
    /(?<!\p{L})(?:ии|ai|модел\p{L}*|нейросет\p{L}*|llm|gpt|gemini|джемини|гемини|groq)(?!\p{L})/iu.test(t) &&
    /(?<!\p{L})(?:какая|какой|какую|какое|на\s+чём|на\s+чем|что\s+за|версия|версию|используешь|работаешь|крутишься|под\s+капотом)(?!\p{L})/iu.test(t)
  );
};

/** Брань в адрес бота (тролль): отвечаем только если получается действительно остро, иначе молчим. */
export const isAbuse = (text) => /(?<!\p{L})(?:иди\s+(?:ты\s+)?(?:на\s*)?х[уy]й|на\s*х[уy]й|пош[её]л\s+(?:ты|на)|сука|суч\p{L}*|ебуч\p{L}*|ебан\p{L}*|пид[оа]р\p{L}*|педрил\p{L}*|долбо[её]б\p{L}*|мраз\p{L}*|урод\p{L}*|дебил\p{L}*|идиот\p{L}*|заткнись|ты\s+(?:никто|мусор|говно))/iu.test(text || '');
