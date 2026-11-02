import { config } from './config.js';

export const REACTIONS = new Set(
  '👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🎉 🤩 🙏 👌 🤡 🥱 😍 💯 🤣 ⚡ 🏆 💔 🤨 😐 😭 🤓 👀 🙈 😇 🤝 🫡 🗿 🆒 😎 🤷 😴 🌚'.split(' '),
);

// ИИ отвечает одним из: SKIP | REACT:<эмодзи> | текст
export function parseReply(raw, { maxLines = 2, maxChars = config.maxReplyChars } = {}) {
  if (!raw) return { type: 'skip' };
  let t = raw.trim().replace(/^["«“]+|["»”]+$/g, '').trim();
  if (!t || /^\W*SKIP\b/i.test(t)) return { type: 'skip' };
  const r = t.match(/^REACT:\s*(\S+)/i);
  if (r) {
    const emoji = r[1].replace(/️/g, '');
    return REACTIONS.has(emoji) ? { type: 'react', emoji } : { type: 'skip' };
  }
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
