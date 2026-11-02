import { config } from './config.js';
import { allChats, dayKey, hourOf, save } from './store.js';
import { sendDigest } from './commands.js';
import { LEVELS, canSpeakUnsolicited } from './filter.js';
import { respond } from './respond.js';
import { pickInitiative, runInitiative, trackIgnore } from './life.js';

async function tick() {
  const now = Date.now();
  const hour = hourOf(now);
  const today = dayKey(now);
  for (const [chatId, st] of allChats()) {
    if (chatId > 0) continue; // только группы
    try {
      trackIgnore(st, now);
      if (st.settings.mutedUntil > now) continue;

      // Итоги дня — раз в сутки
      if (hour === config.digestHour && st.lastDigestDay !== today) {
        st.lastDigestDay = today;
        save();
        await sendDigest(chatId, st);
        continue;
      }

      // Своя жизнь: приветствие, оживление, обращение к людям, байки
      const kind = pickInitiative(st, now, { hour, today });
      if (kind) {
        await runInitiative(chatId, st, kind, today);
        save();
      }
    } catch (e) {
      console.error('[scheduler]', chatId, e.message);
    }
  }
}

export function startScheduler() {
  setInterval(() => tick().catch((e) => console.error('[scheduler]', e)), 60_000);
}

// «Тишина после вопроса»: если вопрос повис без ответа — можно ответить
const pending = new Map();
export function watchQuestion(chatId, st, messageId) {
  clearTimeout(pending.get(chatId));
  pending.set(
    chatId,
    setTimeout(async () => {
      pending.delete(chatId);
      const last = st.history[st.history.length - 1];
      if (!last || last.id !== messageId) return; // кто-то уже ответил
      if (!canSpeakUnsolicited(st, Date.now()) || Math.random() > LEVELS[st.settings.activity].p * 6) return;
      await respond(chatId, st, { mode: 'unanswered', replyTo: messageId });
    }, 4 * 60_000),
  );
}
