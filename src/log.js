// Журнал общения для мониторинга качества: что бот ответил и на что. LOG_REPLIES=0 выключает.
// Тексты участников урезаны и пишутся только как контекст к ответу бота.

const ON = process.env.LOG_REPLIES !== '0';
const cut = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function logSay({ kind, angle, provider, question, answer }) {
  if (!ON) return;
  const meta = [kind, angle && `приём=${angle}`, provider && `модель=${String(provider).split(':').slice(0, 2).join(':')}`].filter(Boolean).join(' ');
  console.log(`[say] ${meta} | Q: «${cut(question, 120)}» | A: «${cut(answer, 300)}»`);
}

export function logTaste(verdict, botText, humanText) {
  if (!ON) return;
  console.log(`[taste] ${verdict} | бот: «${cut(botText, 120)}» | в ответ: «${cut(humanText, 100)}»`);
}

export function logMedia(kind, text) {
  if (!ON) return;
  console.log(`[media] ${kind} распознано: «${cut(text, 200)}»`);
}
