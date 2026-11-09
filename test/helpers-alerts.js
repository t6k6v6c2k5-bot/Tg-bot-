// Общие заготовки для тестов тревог: страница канала t.me/s/<канал> и мок Telegram
export const post = (ch, id, ts, text) =>
  `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="${ch}/${id}"><div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div><a class="tgme_widget_message_date"><time datetime="${new Date(ts).toISOString()}"></time></a></div></div>`;

export const START = '🔴 Криворізький район — повітряна тривога, червоний рівень';
export const END = '🟢 Криворізький район — відбій повітряної тривоги';

/** fetch по каналам: pages = { канал: html }, остальное (API области) — тихо «нет» */
export const mkFetch = (pages, apiAlarm = false) => async (url) => {
  if (url.includes('ubilling')) return { ok: true, text: async () => JSON.stringify({ states: { 'Дніпропетровська область': { alertnow: apiAlarm } } }) };
  if (url.includes('alerts.com.ua')) return { ok: false, status: 500, text: async () => '' };
  return { ok: true, text: async () => pages[url.split('/s/')[1]] || '' };
};
