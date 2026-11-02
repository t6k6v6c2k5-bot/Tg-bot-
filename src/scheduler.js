import { config } from './config.js';
import { botOff } from './owner.js';
import { allChats, dayKey, hourOf, save } from './store.js';
import { sendDigest } from './commands.js';
import { LEVELS, canSpeakUnsolicited } from './filter.js';
import { respond } from './respond.js';
import { learn, learnBacklog } from './memory.js';
import { pickInitiative, runInitiative, trackIgnore } from './life.js';
import { refreshRoster, rosterDue } from './roster.js';

async function tick() {
  if (botOff()) return;
  const now = Date.now();
  const hour = hourOf(now);
  const today = dayKey(now);
  for (const [chatId, st] of allChats()) {
    if (chatId > 0) continue; // только группы
    // бота выгнали: пока в чате не появится новое сообщение, туда не пишем
    if (st.kickedAt && (st.history.at(-1)?.ts ?? 0) < st.kickedAt) continue;
    try {
      trackIgnore(st, now);
      if (rosterDue(st, now)) await refreshRoster(chatId, st);
      // Память не зависит от настроения бота: даже в режиме тишины доучиваем непрочитанное,
      // если чат затих и ИИ снова доступен
      const idle = now - (st.history.at(-1)?.ts ?? 0);
      if (learnBacklog(st) >= 10 && now - st.lastLearnAt > 5 * 60_000 && idle > 2 * 60_000) {
        st.lastLearnAt = now;
        await learn(chatId, st);
        save();
      }
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
      if (/\b403\b|chat not found|bot was kicked|bot was blocked/i.test(e.message)) {
        st.kickedAt = Date.now();
        save(); // переживёт перезапуск
      }
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
