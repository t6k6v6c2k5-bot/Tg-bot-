import { aiStatus, servedInfo } from './ai.js';

const dur = (s) => (s > 5400 ? `${(s / 3600).toFixed(1)} ч` : s > 120 ? `${Math.round(s / 60)} мин` : `${s} с`);

/** Честный ответ из реальных данных, без ИИ: какая модель отвечает, что в цепочке, что на паузе. */
export function modelAnswer(now = Date.now(), env = process.env) {
  const s = aiStatus(now);
  const last = servedInfo();
  const lines = [];
  if (last) lines.push(`Последний ответ дала модель ${last.model} (${last.provider}), ${Math.max(1, Math.round((now - last.at) / 1000))} с назад.`);
  else lines.push('С момента запуска ИИ ещё ни разу не отвечал.');
  const chain = [];
  if (s.gemini.keys) chain.push(`Gemini (ключей ${s.gemini.keys}): ${s.gemini.models.join(', ')}`);
  if (s.groq.keys) chain.push(`Groq (ключей ${s.groq.keys}): ${s.groq.models.join(', ')}`);
  if (s.grok.enabled) chain.push('Grok (xAI)');
  for (const e of s.extra || []) chain.push(`${e.name} (ключей ${e.keys}): ${e.models.join(', ')}`);
  lines.push('Цепочка моделей по порядку: ' + (chain.join('; ') || 'не настроена') + '.');
  if (s.pauses.length) {
    lines.push('На паузе: ' + s.pauses.slice(0, 6).map((p) => `${p.id.replace(/^[mk]:/, '')} (${dur(p.seconds)})`).join(', ') + '.');
  } else lines.push('Пауз нет, все модели доступны.');
  const sha = env.RAILWAY_GIT_COMMIT_SHA;
  if (sha) lines.push(`Версия сборки: ${sha.slice(0, 7)}.`);
  return lines.join('\n');
}
