// Режим бота в чате: свет — только графики и прогноз, смешанный — свет + обычный Батя, без света — обычный Батя без графиков.
export const MODES = { light: '💡 только свет', lightalert: '💡🚨 свет и тревога', mixed: '🎭 смешанный', nolight: '🗣 без света' };
export const NEXT = { light: 'lightalert', lightalert: 'mixed', mixed: 'nolight', nolight: 'light' };

/** Режимы без болтовни: только сервис (свет, при lightalert ещё и тревоги) */
export const lightOnly = (st) => ['light', 'lightalert'].includes(botMode(st));
/** Тревоги идут в чат, если включены отдельно или выбран режим «свет и тревога» */
export const alertsOn = (st) => st?.settings?.alerts === true || botMode(st) === 'lightalert';

export const botMode = (st) => (MODES[st?.settings?.mode] ? st.settings.mode : 'mixed');

export function setBotMode(st, mode) {
  st.settings.mode = MODES[mode] ? mode : 'mixed';
}

/** «свет», «только свет», «смешанный», «без света», «обычный» → ключ режима (или null) */
export function parseMode(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return null;
  if (/без\s+свет|нолайт|nolight|обычн|болтов|чат/.test(t)) return 'nolight';
  if (/тревог|тривог|alert|свет\S*\s*(?:и|\+|&|та)\s*\S*трев|(?:и|\+|&|та)\s*тревог/.test(t)) return 'lightalert';
  if (/смешан|mixed|оба|всё|все\b/.test(t)) return 'mixed';
  if (/свет|свiт|світ|light|прогноз|график|тільки|только/.test(t)) return 'light';
  return null;
}

/** Хардкор: агрессивный режим, бот нападает первым. В режиме «только свет» не действует. */
export const hardcore = (st) => st?.settings?.hardcore === true && !lightOnly(st);
/** Уровень активности с учётом хардкора (там всегда максимум) */
export const effActivity = (st) => (hardcore(st) ? 5 : st.settings.activity);
