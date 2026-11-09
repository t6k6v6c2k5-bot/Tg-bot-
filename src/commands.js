import { config } from './config.js';
import { generate } from './ai.js';
import { logSay } from './log.js';
import { parseReply } from './parse.js';
import { system, digestPrompt, revivePrompt } from './prompts.js';
import { chat, dayKey, save } from './store.js';
import { app, say, roast } from './respond.js';
import { LEVELS } from './filter.js';
import { emptyMemory } from './memory.js';
import { lifeStatus } from './life.js';
import { CRUDE_LEVELS, crudeLevel } from './prompts.js';
import { dossier, statsText, detectTargets } from './analysis.js';
import { runCatchup, hoursFromText } from './catchup.js';
import { outageCommand, outageAll } from './outage.js';
import { alertStatusText } from './alerts.js';
import { botMode, setBotMode, parseMode, MODES, lightOnly } from './botmode.js';
import { isAdminId } from './owner.js';

export const parseCommand = (text) => {
  const m = text.match(/^\/([\p{L}0-9_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/u);
  if (!m) return null;
  return { name: m[1].toLowerCase(), target: m[2], args: (m[3] || '').trim() };
};

const ALIAS = {
  start: 'help', help: 'help', помощь: 'help',
  тихо: 'quiet', quiet: 'quiet', громко: 'loud', loud: 'loud',
  активность: 'activity', activity: 'activity',
  неподкалывай: 'nojoke', nojoke: 'nojoke',
  прожарь: 'roast', roast: 'roast',
  итоги: 'digest', digest: 'digest',
  оживи: 'revive', revive: 'revive',
  тон: 'tone', tone: 'tone',
  жизнь: 'life', life: 'life',
  пошлость: 'crude', crude: 'crude', vulgar: 'crude',
  пропустил: 'catchup', catchup: 'catchup', чтобыло: 'catchup',
  разбор: 'analyze', analyze: 'analyze', статистика: 'stats', стата: 'stats', stats: 'stats',
  чтопомнишь: 'memory', memory: 'memory',
  забудь: 'forget', forget: 'forget', забудь_всё: 'forgetall', забудьвсё: 'forgetall', forgetall: 'forgetall',
  тревога: 'alert', тривога: 'alert', alert: 'alert',
  режим: 'mode', mode: 'mode', хардкор: 'hardcore', hardcore: 'hardcore',
  свет: 'outage', світло: 'outage', график: 'graphs', графік: 'graphs', графики: 'graphs', графіки: 'graphs', graphs: 'graphs', light: 'outage', outage: 'outage',
  табу: 'taboo', taboo: 'taboo', табу_список: 'taboo', табу_сброс: 'tabooreset',
};

export const BOT_COMMANDS = [
  { command: 'help', description: 'Что умеет бот' },
  { command: 'quiet', description: 'Молчать N минут (по умолчанию 60)' },
  { command: 'activity', description: 'Частота вмешательства 1-5' },
  { command: 'roast', description: 'Подколоть: /roast @ник или ответом' },
  { command: 'nojoke', description: 'Не подкалывать меня' },
  { command: 'digest', description: 'Итоги дня сейчас' },
  { command: 'revive', description: 'Оживить чат' },
  { command: 'tone', description: 'Тон подколов: soft / hard' },
  { command: 'taboo', description: 'Табу-темы' },
  { command: 'catchup', description: 'Что я пропустил (можно: /catchup 3)' },
  { command: 'analyze', description: 'Разбор участника: /analyze @ник' },
  { command: 'stats', description: 'Статистика чата' },
  { command: 'crude', description: 'Пошлость и мат в шутках 0-3' },
  { command: 'life', description: 'Самостоятельность бота вкл/выкл' },
  { command: 'memory', description: 'Что бот помнит обо мне' },
  { command: 'light', description: 'Свет: /свет 3.1 запомнит твою очередь' },
  { command: 'graphs', description: 'График света по всем очередям' },
  { command: 'mode', description: 'Режим: свет / смешанный / без света (админ)' },
  { command: 'hardcore', description: 'Хардкор: агрессивный режим (админ)' },
  { command: 'alert', description: 'Тревога сейчас и где летит (админ: вкл/выкл)' },
  { command: 'forget', description: 'Забыть меня и не запоминать' },
];

const HELP = `Я молчу, пока не позовут, и лишь изредка встреваю сам.
Позови по имени, @упоминанием или ответом на моё сообщение.

/тихо [мин] — помолчать (0 — вернуть голос)
/активность 1-5 — как часто влезаю сам (со 2-го уровня сам заговариваю, если долго тихо)
/жизнь вкл|выкл — своя жизнь: приветствия, байки, вопросы и обращения к людям
/прожарь @ник — подколоть (или ответом на сообщение)
/неподкалывай — не подкалывать тебя (повтор — вернуть)
/тон мягко|жёстко|сам — тон подколов (по умолчанию сам решает)
/пошлость 0-3 — 0 чисто, 1 намёки, 2 пошловато и лёгкий мат, 3 как среди взрослых (по умолчанию)
/табу <тема> — запретная тема, /табу_список, /табу_сброс
/чтопомнишь — что я помню о тебе
/забудь — забыть тебя и не запоминать (повтор — вернуть); /забудь_всё — стереть память чата
/пропустил [часов] — пересказ того, что было в чате без тебя (или спроси «батя, что я пропустил?»)
/разбор @ник — что я знаю о человеке и как он ведёт себя в чате
/статистика — кто сколько писал, когда пик, кто молчит
/итоги — итоги дня сейчас (сами приходят вечером)
/оживи — вопрос или опрос для тихого чата
/свет 3.1 — запомнить твою очередь света и показать график (дальше сам кидаю утром и когда он меняется; можно и фразой «моя очередь 3.1»); /свет — мой график; /свет картинка — картинкой; /свет стоп — забыть мою очередь\n/тревога — есть ли тревога в области и последнее «где летит»; /тревога вкл|выкл — сообщения о тревоге и отбое в чате (только админ бота)
/хардкор [вкл|выкл] — агрессивный режим: злой, нападает первым (только админ бота)
/режим свет | свет и тревога | смешанный | без света — режим бота в чате (только админ бота)
/график — график света по всем очередям сейчас (можно и словом «График» без слэша; «графики» тоже работает)`;

// true — сообщение было командой (нашей или чужой), дальше его разбирать не нужно
export async function handleCommand(ctx, cmd, message) {
  if (cmd.target && cmd.target.toLowerCase() !== app.username.toLowerCase()) return true; // чужая команда
  const key = ALIAS[cmd.name];
  if (!key) return false;
  const bm = botMode(chat(ctx.chat.id));
  if (bm === 'nolight' && (key === 'outage' || key === 'graphs')) return true; // в этом чате света нет
  if (lightOnly(chat(ctx.chat.id)) && !['help', 'outage', 'graphs', 'mode', 'hardcore', 'alert'].includes(key)) return true; // «только свет»
  await exec(ctx, key, cmd, message);
  return true;
}

async function exec(ctx, key, cmd, message) {
  const chatId = ctx.chat.id;
  const st = chat(chatId);
  const from = message.from;
  const reply = (t) => say(chatId, st, t, message.message_id);
  const now = Date.now();

  switch (key) {
    case 'mode': {
      if (!isAdminId(from.id)) return void (await reply(`Режим чата: ${MODES[botMode(st)]}. Менять может только админ бота.`));
      const m = parseMode(cmd.args);
      if (!m) return void (await reply(`Режим сейчас: ${MODES[botMode(st)]}. Поставить: /режим свет | свет и тревога | смешанный | без света`));
      setBotMode(st, m);
      save();
      await reply({ light: 'Теперь только свет: графики, прогноз и расчёты, без шуток.', lightalert: '💡🚨 Свет и тревога: графики, прогноз, расчёты и сообщения о тревоге, отбое и «где летит». Без шуток и болтовни.', mixed: 'Смешанный режим: свет плюс обычный Батя.', nolight: 'Без света: обычный Батя, графики в этом чате отключены.' }[m]);
      break;
    }
    case 'alert': {
      const arg = cmd.args.toLowerCase();
      if (/^(?:вкл|on|выкл|off|вимкн|включ)/.test(arg)) {
        if (!isAdminId(from.id)) return void (await reply('Включать и выключать тревоги может только админ бота.'));
        const on = /^(?:вкл|on|включ)/.test(arg);
        if (!on && botMode(st) === 'lightalert') return void (await reply('В режиме «свет и тревога» тревоги выключить нельзя. Поменяй режим: /режим смешанный'));
        st.settings.alerts = on;
        save();
        await reply(on ? '🚨 Тревоги включены: буду писать о тревоге, отбое и «где летит» по области из открытых источников.' : 'Тревоги в этом чате выключены.');
        if (on) await reply(await alertStatusText()); // сразу показываем, что сейчас, чтобы не пропустить уже идущую тревогу
        return;
      }
      await reply(await alertStatusText());
      break;
    }
    case 'hardcore': {
      if (!isAdminId(from.id)) return void (await reply('Хардкор включает только админ бота.'));
      const arg = cmd.args.toLowerCase();
      const on = /^(?:вкл|on|да|1|включ)/.test(arg) ? true : /^(?:выкл|off|нет|0|отбой|стоп)/.test(arg) ? false : !st.settings.hardcore;
      st.settings.hardcore = on;
      save();
      await reply(on ? '☠️ ХАРДКОР включён. Теперь я злой, дерзкий и могу напасть первым. Отбой: /хардкор выкл' : 'Хардкор выключен, возвращаюсь в обычный режим.');
      break;
    }
    case 'graphs':
      await outageAll(chatId, st, message.message_id);
      break;
    case 'outage':
      await outageCommand(chatId, st, cmd.args, message.message_id, from);
      break;
    case 'help':
      await reply(HELP);
      break;
    case 'quiet': {
      const min = cmd.args === '' ? 60 : Number(cmd.args);
      if (!Number.isFinite(min) || min < 0 || min > 24 * 60) return void (await reply('Минуты: число от 0 до 1440.'));
      st.settings.mutedUntil = min ? now + min * 60_000 : 0;
      save();
      await reply(min ? `Ладно, молчу ${min} мин 🤐` : 'Я снова с вами 👋');
      break;
    }
    case 'loud':
      st.settings.mutedUntil = 0;
      save();
      await reply('Я снова с вами 👋');
      break;
    case 'activity': {
      const n = Number(cmd.args);
      if (!LEVELS[n]) return void (await reply(`Сейчас активность ${st.settings.activity}. Поставить: /активность 1-5`));
      st.settings.activity = n;
      save();
      await reply(`Активность ${n}: до ${LEVELS[n].cap} самостоятельных реплик в час.`);
      break;
    }
    case 'crude': {
      const n = Number(cmd.args);
      const names = ['чисто', 'понимаю и намекаю', 'пошловато и лёгкий мат', 'как среди взрослых'];
      if (cmd.args === '' || !(n >= 0 && n <= 3) || !Number.isInteger(n))
        return void (await reply(`Пошлость сейчас: ${crudeLevel(st)} (${names[crudeLevel(st)]}). Поставить: /пошлость 0-3. Несдвигаемые линии на любом уровне: без несовершеннолетних, без откровенного секса, без травли и унижения групп людей.`));
      st.settings.crude = n;
      save();
      await reply(`Пошлость ${n}: ${names[n]}. ${n >= 2 ? 'Но подстраиваюсь под чат: если никто не матерится, и я не буду.' : ''}`.trim());
      break;
    }
    case 'tone':
      if (/жёст|жест|hard/i.test(cmd.args)) st.settings.tone = 'hard';
      else if (/мягк|добр|soft/i.test(cmd.args)) st.settings.tone = 'soft';
      else if (/сам|free|авто/i.test(cmd.args)) st.settings.tone = 'free';
      else return void (await reply(`Тон сейчас: ${{ hard: 'жёсткий', soft: 'мягкий', free: 'сам выбираю' }[st.settings.tone] || 'сам выбираю'}. /тон мягко|жёстко|сам`));
      save();
      await reply({ hard: 'Окей, буду дерзче 😏', soft: 'Окей, буду добрее 😇', free: 'Окей, по ситуации: сам решу, где мягко, где жёстко.' }[st.settings.tone]);
      break;
    case 'nojoke':
      st.optOut[from.id] = !st.optOut[from.id];
      save();
      await reply(st.optOut[from.id] ? 'Принято, тебя не трогаю. Повторная команда вернёт всё назад.' : 'Ну всё, ты в игре 😈');
      break;
    case 'catchup':
      await runCatchup(chatId, st, {
        uid: from.id,
        name: from.first_name || from.username || 'друг',
        username: from.username,
        replyTo: message.message_id,
        hours: hoursFromText(cmd.args),
      });
      break;
    case 'stats':
      await reply(`Статистика чата:\n${statsText(st, now)}`);
      break;
    case 'analyze': {
      const uid = resolveTarget(st, message, cmd.args) || detectTargets(st, cmd.args)[0];
      if (!uid || String(uid) === String(app.id)) return void (await reply('Кого разбирать? Ответь на его сообщение или напиши /разбор @ник (или имя).'));
      const data = dossier(st, uid, now);
      if (st.memOff[uid]) return void (await reply(data));
      const res = await generate({
        system: system(st, app.name, { long: true }),
        prompt: `ДАННЫЕ ЧАТА (посчитано программой, точно):\n${data}\n\nЗадача: сделай короткий дружеский разбор этого участника для чата (до 5 строк): чем живёт в чате (темы, привычки, фирменные фразы), когда активен, с кем общается. Опирайся только на данные выше. Без диагнозов, догадок о личной жизни и обидных выводов; ироничный комплимент в конце.`,
        maxTokens: 450,
        high: true,
        tier: 'smart',
      });
      const r = res && parseReply(res.text, { maxLines: 6, maxChars: 800 });
      await reply(r?.type === 'text' ? r.text : data);
      break;
    }
    case 'life': {
      if (/^(вкл|on|да)/i.test(cmd.args)) st.settings.autonomy = true;
      else if (/^(выкл|off|нет)/i.test(cmd.args)) st.settings.autonomy = false;
      else return void (await reply(st.settings.autonomy === false ? 'Своя жизнь выключена. Включить: /жизнь вкл' : `Своя жизнь включена. ${lifeStatus(st)}`));
      save();
      await reply(st.settings.autonomy ? 'Живу своей жизнью: могу и поздороваться, и позвать кого-нибудь.' : 'Хорошо, сам заговаривать не буду. Только если позовут.');
      break;
    }
    case 'memory': {
      if (st.memOff[from.id]) return void (await reply('Ты просил тебя не запоминать, так что я о тебе ничего не веду. Вернуть: /забудь'));
      const facts = (st.memory.users[from.id] || []).map((f) => `• ${f.t}`);
      await reply(facts.length ? `Что я о тебе помню:\n${facts.join('\n')}\n\nНе нравится — /забудь.` : 'Пока ничего особенного не записал.');
      break;
    }
    case 'forget':
      st.memOff[from.id] = !st.memOff[from.id];
      if (st.memOff[from.id]) delete st.memory.users[from.id];
      save();
      await reply(st.memOff[from.id] ? 'Всё стёр и больше про тебя ничего не записываю. Повтор команды вернёт запоминание.' : 'Ладно, снова запоминаю тебя 🙂');
      break;
    case 'forgetall':
      st.memory = emptyMemory();
      save();
      await reply('Память чата стёрта. Знакомимся заново, орлы.');
      break;
    case 'taboo': {
      if (!cmd.args) return void (await reply(st.taboo.length ? `Табу: ${st.taboo.join('; ')}` : 'Табу-тем нет. Добавить: /табу <тема>'));
      if (st.taboo.length >= 20) return void (await reply('Слишком много табу, сначала /табу_сброс'));
      st.taboo.push(cmd.args.slice(0, 60));
      save();
      await reply('Запомнил, эту тему обхожу.');
      break;
    }
    case 'tabooreset':
      st.taboo = [];
      save();
      await reply('Табу-список очищен.');
      break;
    case 'roast': {
      const uid = resolveTarget(st, message, cmd.args);
      if (!uid) return void (await reply('Кого жарить? Ответь на его сообщение или напиши /прожарь @ник (он должен был хоть раз написать).'));
      if (String(uid) === String(app.id)) return void (await reply('Себя жарить не буду, я и так огонь 🔥'));
      if (st.optOut[uid]) return void (await reply('Этот человек просил его не трогать — уважаем.'));
      const wait = config.roastCooldownMs - (now - (st.roastLast[uid] || 0));
      if (wait > 0) return void (await reply(`Его недавно уже задевали, дай человеку отдохнуть (ещё ~${Math.ceil(wait / 60_000)} мин).`));
      await roast(chatId, st, { targetUid: uid, askedBy: from.first_name, replyTo: message.message_id });
      break;
    }
    case 'digest':
      if (now - st.lastDigestCmdAt < 30 * 60_000) return void (await reply('Итоги недавно уже были, не частите.'));
      st.lastDigestCmdAt = now;
      if (!(await sendDigest(chatId, st))) await reply('Сегодня слишком тихо — итогов не будет.');
      break;
    case 'revive':
      if (!(await sendRevive(chatId, st))) await reply('Сейчас не лучший момент оживлять чат.');
      break;
  }
}

function resolveTarget(st, message, args) {
  const nick = args.match(/@(\w+)/)?.[1]?.toLowerCase();
  if (nick) {
    const hit = Object.entries(st.users).find(([, u]) => u.username?.toLowerCase() === nick);
    return hit?.[0];
  }
  const r = message.reply_to_message?.from;
  if (r && !r.is_bot) return String(r.id);
  return undefined;
}

// ---- итоги дня и оживление: используются и командами, и планировщиком ----

export async function sendDigest(chatId, st) {
  const today = dayKey(Date.now());
  const msgs = st.history.filter((m) => !m.bot && dayKey(m.ts) === today);
  if (msgs.length < config.digestMinMessages) return false;
  const lines = msgs
    .slice(-250)
    .map((m) => `${m.name}: ${m.text.replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n');
  const res = await generate({ system: system(st, app.name), prompt: digestPrompt(lines), maxTokens: 500, temperature: 0.8 });
  if (!res || /^\W*SKIP\b/i.test(res.text)) return false;
  logSay({ kind: 'итоги дня', provider: res.provider, question: `${msgs.length} сообщений за день`, answer: res.text });
  await say(chatId, st, res.text.slice(0, 1500));
  // «память дней»: потом по ней Батя отвечает на «о чём вчера говорили»
  const days = (st.memory.days ||= {});
  days[today] = res.text.slice(0, 1200);
  for (const d of Object.keys(days).sort().slice(0, -30)) delete days[d];
  save();
  return true;
}

export async function sendRevive(chatId, st) {
  const res = await generate({ system: system(st, app.name), prompt: revivePrompt(st.history), maxTokens: 150, temperature: 1, tier: 'smart' });
  if (!res) return false;
  const poll = res.text.match(/^POLL:\s*(.+)$/im);
  if (poll) {
    const [q, ...opts] = poll[1].split('|').map((s) => s.trim()).filter(Boolean);
    if (q && opts.length >= 2) {
      logSay({ kind: 'оживление:опрос', provider: res.provider, question: '', answer: `${q} | ${opts.join(' | ')}` });
      await app.telegram.sendPoll(chatId, q.slice(0, 250), opts.slice(0, 4).map((o) => o.slice(0, 100)), { is_anonymous: true });
      st.lastReviveAt = Date.now();
      return true;
    }
  }
  const r = parseReply(res.text);
  if (r.type !== 'text') return false;
  logSay({ kind: 'оживление', provider: res.provider, question: '', answer: r.text });
  await say(chatId, st, r.text);
  st.lastReviveAt = Date.now();
  return true;
}
