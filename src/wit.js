import { generate } from './ai.js';
import { parseReply } from './parse.js';
import { config } from './config.js';

// «Редакторская»: бот пишет несколько разных вариантов реплики, а отдельный редактор выбирает самый остроумный.
// Если все варианты слабые, а Батю не звали, лучше промолчать.

const SUFFIX = `

Сделай ровно 4 РАЗНЫХ варианта этой реплики (разные приёмы и углы, не перефразы друг друга), по одному на строку, формат «1) …», «2) …». Каждый — готовая к отправке реплика, самый короткий вариант шутки, и обязательно по смыслу связан с тем, что сказал человек. Каждый вариант — одна мысль и не больше одного сравнения, до 20 слов. Перед выбором проверь каждую шутку на логику: если нельзя пересказать простыми словами, в чём смысл, она бессмысленна — не выбирай её. Последней строкой честно оцени как строгий редактор юмора: «ЛУЧШИЙ: N» — номер самого смешного и остроумного варианта, или «ЛУЧШИЙ: 0», если все слабые или банальные. Если сказать нечего или момент неподходящий, ответь только SKIP.`;

// «ЛУЧШИЙ: 3» → 3; нет пометки → null
export function parseBest(text) {
  const m = text.match(/ЛУЧШ\p{L}*\s*[:\-–]?\s*(\d+)/iu);
  return m ? Number(m[1]) : null;
}

export function parseCandidates(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (/ЛУЧШ/iu.test(line)) continue;
    const m = line.match(/^\s*(?:\d+\s*[).:]|[-•*])\s*(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

const JUDGE_SYSTEM =
  'Ты строгий редактор юмора в дружеском чате. Ценишь остроумие: неожиданный поворот, точность, лаконичность, игру слов, попадание в то, что реально сказали. Не любишь банальность, натужность, объяснённые шутки и бессмыслицу.';

function judgePrompt(context, cands, allowZero) {
  return `Контекст чата (последние сообщения):\n${context}\n\nВарианты реплики Бати:\n${cands.map((c, i) => `${i + 1}) ${c}`).join('\n')}\n\nВыбери ОДИН лучший: самый смешной и остроумный, при этом уместный и осмысленный.${allowZero ? ' Если все варианты слабые, банальные или бессмысленные — ответь 0.' : ''} Ответь только числом.`;
}

/**
 * Возвращает объект, совместимый с generate(): { text, provider }.
 * text = 'SKIP', если сказать нечего или все варианты слабые (и ответ не обязателен).
 * @param {object} o
 * @param {string} o.system
 * @param {string} o.prompt
 * @param {string} o.context      короткий контекст для редактора
 * @param {boolean} o.direct      к Бате обратились: ответить надо в любом случае
 * @param {(text:string)=>boolean} [o.reject]  вариант не годится (повтор, запрещённое)
 */
export async function bestOf({ system, prompt, context, direct, reject = () => false, tier = 'fast', high = false, maxTokens = 100, parseOpts }) {
  const res = await generate({ system, prompt: prompt + SUFFIX, maxTokens: maxTokens * 4 + 40, temperature: 1, tier, high });
  if (!res) return null;
  if (/^\W*SKIP\b/i.test(res.text.trim())) return { text: 'SKIP', provider: res.provider };

  const raw = parseCandidates(res.text);
  const selfPick = parseBest(res.text);
  // индекс исходного списка → годный вариант (чтобы «ЛУЧШИЙ: N» указывал на нужную строку)
  const parsed = (raw.length ? raw : [res.text.replace(/ЛУЧШ.*$/imu, '')]).map((c) => parseReply(c, parseOpts));
  const good = parsed.map((r, i) => ({ i: i + 1, r })).filter(({ r }) => r.type === 'text' && !reject(r.text));
  if (!good.length) return { text: 'SKIP', provider: res.provider, rejected: true };
  const cands = good.map(({ r }) => r.text);

  // 1) самооценка модели из того же запроса (один запрос на реплику)
  if (!config.witJudge || cands.length === 1) {
    if (selfPick === 0 && !direct) return { text: 'SKIP', provider: res.provider, weak: true };
    const chosen = good.find(({ i }) => i === selfPick) || good[0];
    return { text: chosen.r.text, provider: res.provider, pick: chosen.i, judged: selfPick != null };
  }

  // 2) отдельный редактор (WIT_JUDGE=1): ещё один запрос, зато независимый взгляд
  const j = await generate({
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(context, cands, !direct),
    maxTokens: 8,
    temperature: 0,
    tier: 'fast',
    high,
  });
  const n = j ? Number((j.text.match(/\d+/) || [''])[0]) : NaN;
  if (n === 0 && !direct) return { text: 'SKIP', provider: res.provider, weak: true }; // все слабые — лучше промолчать
  const pick = Number.isInteger(n) && n >= 1 && n <= cands.length ? n - 1 : 0;
  return { text: cands[pick], provider: res.provider, judged: Boolean(j), pick: pick + 1 };
}
