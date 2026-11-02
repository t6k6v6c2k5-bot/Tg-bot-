import { config } from './config.js';
import { allChats, dayKey, hourOf, save } from './store.js';
import { sendDigest, sendRevive } from './commands.js';
import { LEVELS, canSpeakUnsolicited } from './filter.js';
import { respond } from './respond.js';

const HOUR = 3600_000;

async function tick() {
  const now = Date.now();
  const hour = hourOf(now);
  for (const [chatId, st] of allChats()) {
    if (chatId > 0 || st.settings.mutedUntil > now) continue; // только группы, не в режиме тишины
    try {
      // Итоги дня — раз в сутки
      const today = dayKey(now);
      if (hour === config.digestHour && st.lastDigestDay !== today) {
        st.lastDigestDay = today;
        save();
        await sendDigest(chatId, st);
        continue;
      }
      // Оживление: днём, после долгой тишины в обычно живом чате
      const lastHuman = [...st.history].reverse().find((m) => !m.bot)?.ts ?? 0;
      const silent = now - lastHuman;
      if (
        hour >= 11 && hour < 22 &&
        st.settings.activity >= 2 &&
        silent > 4 * HOUR && silent < 3 * 24 * HOUR &&
        now - st.lastReviveAt > 12 * HOUR &&
        st.history.length > 30 &&
        canSpeakUnsolicited({ ...st, history: [] }, now)
      ) {
        st.lastReviveAt = now; // фиксируем попытку, даже если ИИ скажет SKIP
        if (await sendRevive(chatId, st)) {
          st.unsol.push(now);
          st.lastUnsolAt = now;
        }
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
