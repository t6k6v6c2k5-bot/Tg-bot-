import { config } from './config.js';

export const REACTIONS = new Set(
  '👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🎉 🤩 🙏 👌 🤡 🥱 😍 💯 🤣 ⚡ 🏆 💔 🤨 😐 😭 🤓 👀 🙈 😇 🤝 🫡 🗿 🆒 😎 🤷 😴 🌚'.split(' '),
);

// ИИ отвечает одним из: SKIP | REACT:<эмодзи> | текст
export function parseReply(raw, { maxLines = 4, maxChars = config.maxReplyChars } = {}) {
  if (!raw) return { type: 'skip' };
  let t = raw.trim();
  // кавычки срезаем, только если они парой обрамляют ВЕСЬ текст («…» целиком); иначе получится осиротевшая «»»
  const PAIRS = { '"': '"', '«': '»', '“': '”' };
  const close = PAIRS[t[0]];
  if (close && t.length > 1 && t.at(-1) === close && !t.slice(1, -1).includes(close)) t = t.slice(1, -1).trim();
  t = t.replace(/^(?:Батя|Бот)\s*:\s*/i, ''); // некоторые модели начинают с «Батя:»
  if (!t || /^\W*SKIP\b/i.test(t)) return { type: 'skip' };
  // отказ по несдвигаемым линиям: «REFUSE: короткая фраза в образе»
  const ref = t.match(/^\W*REFUSE\b\s*[:\-–]?\s*(.*)$/is);
  if (ref) return { type: 'refuse', text: ref[1].trim().split('\n')[0].slice(0, 200) };
  const r = t.match(/^REACT:\s*(\S+)/i);
  if (r) {
    const emoji = r[1].replace(/️/g, '');
    return REACTIONS.has(emoji) ? { type: 'react', emoji } : { type: 'skip' };
  }

  // протечка рассуждений: английский текст или служебные пометки вместо реплики
  const cyr = (t.match(/[а-яёіїєґ]/gi) || []).length;
  const lat = (t.match(/[a-z]/gi) || []).length;
  if (lat > cyr || /^(draft|answer|thinking|reasoning|teasing|note)\s*:/im.test(t)) return { type: 'skip' };
  // 1–2 строки, ограничение по длине
  t = t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join('\n');
  if (t.length > maxChars) t = t.slice(0, maxChars - 1).trimEnd() + '…';
  return { type: 'text', text: t };
}
