import { config } from './config.js';

export const REACTIONS = new Set(
  '👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🎉 🤩 🙏 👌 🤡 🥱 😍 💯 🤣 ⚡ 🏆 💔 🤨 😐 😭 🤓 👀 🙈 😇 🤝 🫡 🗿 🆒 😎 🤷 😴 🌚'.split(' '),
);

// ИИ отвечает одним из: SKIP | REACT:<эмодзи> | текст
export function parseReply(raw) {
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
    .slice(0, 2)
    .join('\n');
  if (t.length > config.maxReplyChars) t = t.slice(0, config.maxReplyChars - 1).trimEnd() + '…';
  return { type: 'text', text: t };
}
