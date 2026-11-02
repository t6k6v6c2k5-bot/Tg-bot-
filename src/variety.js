// Разнообразие: у каждой реплики свой «приём», бот помнит, что говорил, и не повторяется.

export const ANGLES = [
  { id: 'dry', t: 'сухая констатация факта с неожиданной концовкой' },
  { id: 'absurd', t: 'абсурдное сравнение или преувеличение' },
  { id: 'question', t: 'встречный вопрос в лоб' },
  { id: 'callback', t: 'отсылка к тому, что говорили выше в чате' },
  { id: 'fakeserious', t: 'делано серьёзный тон, будто это государственный вопрос' },
  { id: 'self', t: 'самоирония бота' },
  { id: 'short', t: 'максимально коротко: 2–5 слов' },
  { id: 'aphorism', t: 'мини-афоризм по теме разговора' },
  { id: 'advice', t: 'нелепый, но убедительный совет по теме' },
  { id: 'hype', t: 'преувеличенный восторг или похвала' },
  { id: 'story', t: 'мини-история в одну строку' },
  { id: 'plain', t: 'без шутки: по-человечески тепло или по делу' },
];

// Какие приёмы заходят этому чату: берём чаще, но всегда оставляем шанс остальным
export function pickAngle(st, rng = Math.random) {
  const stats = st.taste?.angles || {};
  const pool = ANGLES.filter((a) => a.id !== st.lastAngle);
  const weight = (a) => 0.4 + (stats[a.id]?.ema ?? 0.5);
  let r = rng() * pool.reduce((sum, a) => sum + weight(a), 0);
  for (const a of pool) if ((r -= weight(a)) < 0) return a;
  return pool[0];
}

// Заезженные слова и образы: не должны повторяться из реплики в реплику
export const STOCK = ['шапк', 'поел', 'поеш', 'покуш', 'обед', 'ужин', 'борщ', 'пельмен', 'гараж', 'дач', 'чайк', 'чаю', 'оболтус', 'орл', 'молодёж', 'молодеж', 'понедельник', 'в наше время', 'сынок', 'философ', 'пораньше', 'кофе'];

const stems = (t) => new Set(t.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 3).map((w) => w.slice(0, 5)));

export const recentBotReplies = (st, n = 6) => st.history.filter((m) => m.bot).slice(-n).map((m) => m.text);

/** Что в реплике повторяет недавние. [] — всё свежо. */
const opener = (t) => t.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
const EMOJI = /\p{Extended_Pictographic}/u;

/** Если эмодзи уже были в 2 из 3 последних реплик, в этой их нет (иначе выглядит как штамп). */
export function trimEmoji(text, st) {
  const last3 = recentBotReplies(st, 3);
  if (last3.filter((r) => EMOJI.test(r)).length < 2) return text;
  return text.replace(/\s*(?:\p{Extended_Pictographic}|\u200d|\ufe0f)+/gu, '').trim();
}

export function repetition(text, st) {
  const recent = recentBotReplies(st, 5);
  const low = text.toLowerCase();
  // одинаковое начало («Слушай, Ваня», «Ну ты даёшь») в недавних репликах
  const o = opener(text);
  if (o.split(' ').length >= 2 && recent.some((r) => opener(r) === o)) return [`начало «${o}…» (начни иначе)`];
  // то же первое слово («Слушай», «Ну») уже в двух из четырёх последних реплик
  const first = o.split(' ')[0];
  if (first && recent.slice(-4).filter((r) => opener(r).split(' ')[0] === first).length >= 2) return [`слово «${first}» в начале (начни иначе)`];
  const hits = STOCK.filter((w) => low.includes(w) && recent.some((r) => r.toLowerCase().includes(w)));
  if (hits.length) return hits;
  const mine = stems(text);
  if (mine.size >= 3)
    for (const r of recent) {
      const other = stems(r);
      const common = [...mine].filter((x) => other.has(x)).length;
      if (common / Math.min(mine.size, other.size) >= 0.6) return ['(реплика слишком похожа на прежнюю)'];
    }
  return [];
}

const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

export function styleBlock(st, angle, banned = []) {
  const lines = ['', `СТИЛЬ ЭТОЙ РЕПЛИКИ: ${angle.t}.`];
  const recent = recentBotReplies(st, 6);
  if (recent.length) lines.push(`РАЗНООБРАЗИЕ. Твои последние реплики (не повторяй ни слов, ни шуток, ни приёмов, ни обращений из них):\n${recent.map((r) => '- ' + r.replace(/\s+/g, ' ').slice(0, 120)).join('\n')}`);
  if (banned.length) lines.push(`НЕ используй в этой реплике: ${banned.join(', ')}.`);
  const liked = st.taste?.liked || [];
  const disliked = st.taste?.disliked || [];
  if (liked.length) lines.push(`Что рассмешило этот чат раньше (ориентир на вкус, не копируй):\n${pick(liked, 3).map((x) => '- ' + x.t).join('\n')}`);
  if (disliked.length) lines.push(`Что НЕ зашло (так не шути):\n${pick(disliked, 3).map((x) => '- ' + x.t).join('\n')}`);
  return lines.join('\n');
}
