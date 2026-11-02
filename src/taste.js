import { LAUGH } from './filter.js';

// Учимся на реакции чата: смеются, ругаются или просто отвечают на реплики бота.

// Критика реплик бота: «не смешно», «набор слов», «бред», «чушь», «что за ерунда» и т. п.
const NEG = /(?<!\p{L})(?:не\s*смешн\p{L}*|несмешн\p{L}*|скучно|тупо|тупая\s+шутка|плохая\s+шутка|заколебал|достал|хватит|надоел|отстань|заткнись|кринж|банальн\p{L}*|одно\s+и\s+то\s+же|повторяешься|надоело|набор\s+слов|(?:понос|словесн\p{L}*\s+понос)\p{L}*(?:\s+(?:слов|выражен\p{L}*))?|пустослов\p{L}*|пуст\p{L}+\s+болтовн\p{L}*|несвязн\p{L}*|ни\s+о\s+чём|бред\p{L}*|чушь|ерунд\p{L}*|бессмыслиц\p{L}*|абсурд\p{L}*\s+какой|без\s+смысла|мимо|не\s+понял\s+(?:шутк|юмор)\p{L}*|что\s+за\s+(?:бред|чушь|ерунда)|фу\b)/iu;

export const isCriticism = (text) => NEG.test(text || '');
const KEEP = 8;

const bump = (st, id, score) => {
  if (!id) return;
  const a = ((st.taste ||= { liked: [], disliked: [], angles: {} }).angles[id] ||= { n: 0, ema: 0.5 });
  a.ema = a.ema * 0.8 + score * 0.2;
  a.n++;
};

const push = (list, text) => {
  list.push({ t: text.replace(/\s+/g, ' ').slice(0, 140), ts: Date.now() });
  while (list.length > KEEP) list.shift();
};

/**
 * Вызывается для каждого сообщения человека (оно уже последнее в st.history).
 * Находит реплику бота, на которую это реакция, и оценивает её.
 * @returns {'liked'|'disliked'|'engaged'|null}
 */
export function recordFeedback(st, msg, now = Date.now()) {
  const text = msg.text || '';
  const hist = st.history;
  let target = null;
  const rid = msg.reply_to_message?.message_id;
  if (rid) target = hist.find((m) => m.bot && m.id === rid) || null;
  const viaReply = Boolean(target);
  if (!target)
    for (let i = hist.length - 2; i >= Math.max(0, hist.length - 5); i--)
      if (hist[i].bot) {
        if (now - hist[i].ts < 3 * 60_000) target = hist[i];
        break;
      }
  if (!target || target.scored) return null;

  const laugh = LAUGH.test(text);
  const neg = NEG.test(text);
  st.taste ||= { liked: [], disliked: [], angles: {} };
  if (neg) {
    push(st.taste.disliked, target.text);
    bump(st, target.angle, 0);
    target.scored = true;
    return 'disliked';
  }
  if (laugh) {
    push(st.taste.liked, target.text);
    bump(st, target.angle, 1);
    target.scored = true;
    return 'liked';
  }
  if (viaReply) {
    bump(st, target.angle, 0.7); // ответили боту — уже неплохо
    target.scored = true;
    return 'engaged';
  }
  return null;
}
