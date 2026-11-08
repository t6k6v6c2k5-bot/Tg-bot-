import { config } from './config.js';

/** «Сколько времени?», «Батя, время», «который час» — короткий вопрос именно про время */
export const isTimeQuestion = (text) =>
  /^(?:батя|бать|бот)?[\s,!.]*(?:(?:сколько|скільки)\s+(?:сейчас\s+|зараз\s+)?(?:врем\p{L}*|час\p{L}*)(?:\s+(?:сейчас|зараз))?|который\s+(?:сейчас\s+)?час|котра\s+(?:зараз\s+)?годин\p{L}*|врем\p{L}*|час)[\s?!.]*$/iu.test((text || '').trim());

export function timeAnswer(now = Date.now()) {
  const t = new Intl.DateTimeFormat('ru-RU', { timeZone: config.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const place = /Kyiv|Kiev/.test(config.tz) ? 'В Києві' : 'У тебе в часовому поясі бота';
  return `🕐 ${place} зараз ${t}.`;
}
