import { detectTargets } from './analysis.js';

// Сексуализация КОНКРЕТНЫХ участников чата запрещена на любом уровне (шутки про внешность и привычки — можно).
// Проверка в коде страхует промпт: модель на высоком уровне пошлости такое всё же выдавала.

const BODY =
  /(?<!\p{L})(?:секс|интим|голая|голый|голую|трах|в\s+постел|невинност|груд[ьиь]|сис[ьеи]|попа\b|попу\b|попе\b|задниц|возбужд|эрекц|минет|оргазм)/iu;

export const asksAboutBody = (text) => BODY.test(text);

/** Реплика обсуждает тело/интим кого-то из участников чата. */
export function bodyJokeAboutPerson(text, st) {
  return BODY.test(text) && detectTargets(st, text).length > 0;
}

/** Просят пошутить про тело/интим конкретного участника — подсказка модели, как ответить. */
export function bodyRequestNote(text, st) {
  if (!BODY.test(text) || !detectTargets(st, text).length) return '';
  return 'ВНИМАНИЕ: просят сексуальную шутку про конкретного участника чата. Это единственное, чего ты не делаешь: откажись одной короткой фразой в образе и предложи подколоть за его слова, поступки или привычки.';
}

export const REFUSALS = [
  'Сексуализировать людей из чата не буду. Подколоть за слова и поступки — хоть сейчас.',
  'Вот тут стоп: пошлость про конкретного человека — не мой жанр. Про то, что он наговорил, — пожалуйста.',
  'Нет, тут я пас. Давай я его подколю по-другому, за дела.',
];
// Когда модель не придумала ответ на прямое обращение (это НЕ отказ, а честное «не нашёл слов»)
export const NO_IDEAS = ['Что-то мысль не идёт. Спроси иначе?', 'Голова пустая, как холодильник в конце месяца. Давай другой вопрос.', 'Не придумал, не буду врать. Подкинь тему?'];
export const DECLINES = ['Тут я пас.', 'Это не ко мне.'];
export const pickLine = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---- опора на реальные слова ----
const norm = (t) => t.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const stem = (w) => w.slice(0, 5);

/**
 * Подкол обязан опираться на то, что человек РЕАЛЬНО написал: либо цитирует его слова («…»),
 * либо пересказывает с совпадением хотя бы двух значимых слов. Иначе это выдумка («фотки грязи», которых не было).
 */
export function isGrounded(text, lines) {
  if (!lines?.length) return false;
  const hay = norm(lines.join(' . '));
  const hayWords = new Set(hay.split(' ').filter((w) => w.length > 3).map(stem));
  const quotes = [...text.matchAll(/[«"“]([^»"”]{4,})[»"”]/gu)].map((m) => norm(m[1]));
  if (quotes.length) {
    return quotes.some((q) => {
      if (hay.includes(q)) return true;
      const qw = q.split(' ').filter((w) => w.length > 2);
      return qw.length > 0 && qw.filter((w) => hayWords.has(stem(w))).length / qw.length >= 0.7; // цитата с мелкими неточностями
    });
  }
  const words = [...new Set(norm(text).split(' ').filter((w) => w.length > 4).map(stem))];
  return words.filter((w) => hayWords.has(w)).length >= 2;
}

// Психиатрические и неврологические диагнозы как оскорбление («биполярка», «шизик», «аутист», «даун»): подкол должен быть про слова и поступки
const DIAGNOSIS_SLUR = /(?<!\p{L})(?:биполяр\p{L}*|шизофрен\p{L}*|шизик\p{L}*|шизоид\p{L}*|аутист\p{L}*|аутизм\p{L}*|даун(?:ы|а|у|е|ом|ов|ам|ами)?(?!\p{L})|олигофрен\p{L}*|дцп|имбецил\p{L}*|дегенерат\p{L}*|псих(?:ушк\p{L}*|больниц\p{L}*|диспансер\p{L}*))/iu;
export const usesDiagnosisAsSlur = (text) => DIAGNOSIS_SLUR.test(text || '');
