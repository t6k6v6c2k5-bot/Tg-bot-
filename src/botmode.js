// Режим бота в чате: свет — только графики и прогноз, смешанный — свет + обычный Батя, без света — обычный Батя без графиков.
export const MODES = { light: '💡 только свет', mixed: '🎭 смешанный', nolight: '🗣 без света' };
export const NEXT = { light: 'mixed', mixed: 'nolight', nolight: 'light' };

export const botMode = (st) => (MODES[st?.settings?.mode] ? st.settings.mode : 'mixed');

export function setBotMode(st, mode) {
  st.settings.mode = MODES[mode] ? mode : 'mixed';
}

/** «свет», «только свет», «смешанный», «без света», «обычный» → ключ режима (или null) */
export function parseMode(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return null;
  if (/без\s+свет|нолайт|nolight|обычн|болтов|чат/.test(t)) return 'nolight';
  if (/смешан|mixed|оба|всё|все\b/.test(t)) return 'mixed';
  if (/свет|свiт|світ|light|прогноз|график|тільки|только/.test(t)) return 'light';
  return null;
}
