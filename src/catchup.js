import { generate } from './ai.js';
import { parseReply } from './parse.js';
import { system } from './prompts.js';
import { app, say } from './respond.js';
import { nameRe } from './analysis.js';
import { hourOf } from './store.js';

// «Что я пропустил?» — пересказ чата для того, кто отсутствовал.

const H = 3600_000;
const MAX_LINES = 250;

// Естественная речь: «батя, что я пропустил?», «что тут было», «введи в курс»
export const isCatchupRequest = (text) =>
  /(?<!\p{L})(что\s+(?:я\s+|мы\s+)?(?:тут\s+|там\s+)?(?:пропустил[аи]?|было|происходит|случилось|обсуждал[иа]|обсуждаете|нового)|о\s+чём\s+(?:тут\s+)?(?:говорили|речь|спор)|о\s+чем\s+(?:тут\s+)?(?:говорили|речь|спор)|введи\s+в\s+курс|перескажи\s+(?:чат|что|вкратце)|кратко\s+что)/iu.test(text);

export const hoursFromText = (text) => {
  const m = text.match(/(\d{1,3})\s*(?:ч|час)/iu) || text.match(/^\s*(\d{1,3})\s*$/);
  return m ? Math.min(48, Math.max(1, Number(m[1]))) : null;
};

// С какого момента пересказывать: явные часы > с момента последнего сообщения человека > 6 ч
export function catchupWindow(st, uid, now, hours) {
  if (hours) return { since: now - hours * H, why: `за последние ${hours} ч` };
  const mine = st.history.filter((m) => !m.bot && String(m.uid) === String(uid));
  // предпоследнее: последнее — это сам вопрос
  const prev = mine.length >= 2 ? mine[mine.length - 2].ts : 0;
  if (prev && now - prev <= 24 * H) {
    const since = Math.min(prev, now - H); // не меньше часа
    return { since, why: 'с тех пор, как ты в последний раз писал(а)' };
  }
  return { since: now - 6 * H, why: 'за последние 6 ч' };
}

const clock = (ts) => `${String(hourOf(ts)).padStart(2, '0')}:${String(new Date(ts).getMinutes()).padStart(2, '0')}`;

export async function runCatchup(chatId, st, { uid, name, username, replyTo, hours }) {
  const now = Date.now();
  if (now - (st.lastCatchupAt || 0) < 60_000) {
    await say(chatId, st, 'Только что рассказывал, пролистай вверх 🙂', replyTo);
    return;
  }
  st.lastCatchupAt = now;

  const { since, why } = catchupWindow(st, uid, now, hours);
  const msgs = st.history.filter((m) => m.ts >= since && !(m.bot && m.text.startsWith('Только что')));
  const humans = msgs.filter((m) => !m.bot);
  if (humans.length < 4) {
    await say(chatId, st, `Ничего интересного, ${why} было почти тихо.`, replyTo);
    return;
  }
  const slice = msgs.slice(-MAX_LINES);
  const lines = slice.map((m) => `[${clock(m.ts)}] ${m.bot ? 'Батя' : m.name}: ${m.text.replace(/\s+/g, ' ').slice(0, 180)}`).join('\n');
  // что относилось лично к спрашивающему
  const re = nameRe(name);
  const personal = slice.filter((m) => !m.bot && String(m.uid) !== String(uid) && (re.test(m.text) || (username && m.text.toLowerCase().includes('@' + username.toLowerCase()))));

  const prompt = `Сообщения чата ${why} (${humans.length} от людей${msgs.length > MAX_LINES ? `, показаны последние ${MAX_LINES}` : ''}), сверху старые:
${lines}
${personal.length ? `\nЛично к ${name} обращались:\n${personal.slice(-6).map((m) => `- ${m.name}: ${m.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')}\n` : ''}
Задача: перескажи пропущенное для ${name}, который отсутствовал. 4–6 строк: о чём говорили (темы по порядку), кто что предложил или решил, договорённости и планы, что адресовано лично ему (если есть — назови это отдельно), смешные моменты. Опирайся только на текст выше, ничего не выдумывай, имена и цифры не искажай. В образе Бати, но суть важнее шуток.`;

  const res = await generate({
    system: system(st, app.name, { long: true }),
    prompt,
    maxTokens: 600,
    temperature: 0.5,
    high: true,
    tier: 'smart',
  });
  const r = res && parseReply(res.text, { maxLines: 8, maxChars: 1100 });
  await say(chatId, st, r?.type === 'text' ? r.text : 'Что-то я приболел, пересказать не смог. Попроси чуть позже 🤒', replyTo);
}
