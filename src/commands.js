import { config } from './config.js';
import { generate } from './ai.js';
import { parseReply } from './parse.js';
import { system, digestPrompt, revivePrompt } from './prompts.js';
import { chat, dayKey, save } from './store.js';
import { app, say, roast } from './respond.js';
import { LEVELS } from './filter.js';
import { emptyMemory } from './memory.js';

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
  чтопомнишь: 'memory', memory: 'memory',
  забудь: 'forget', forget: 'forget', забудь_всё: 'forgetall', забудьвсё: 'forgetall', forgetall: 'forgetall',
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
  { command: 'life', description: 'Самостоятельность бота вкл/выкл' },
  { command: 'memory', description: 'Что бот помнит обо мне' },
  { command: 'forget', description: 'Забыть меня и не запоминать' },
];

const HELP = `Я молчу, пока не позовут, и лишь изредка встреваю сам.
Позови по имени, @упоминанием или ответом на моё сообщение.

/тихо [мин] — помолчать (0 — вернуть голос)
/активность 1-5 — как часто влезаю сам (со 2-го уровня сам заговариваю, если долго тихо)
/жизнь вкл|выкл — своя жизнь: приветствия, байки, вопросы и обращения к людям
/прожарь @ник — подколоть (или ответом на сообщение)
/неподкалывай — не подкалывать тебя (повтор — вернуть)
/тон мягко|жёстко — тон подколов
/табу <тема> — запретная тема, /табу_список, /табу_сброс
/чтопомнишь — что я помню о тебе
/забудь — забыть тебя и не запоминать (повтор — вернуть); /забудь_всё — стереть память чата
/итоги — итоги дня сейчас (сами приходят вечером)
/оживи — вопрос или опрос для тихого чата`;

// true — сообщение было командой (нашей или чужой), дальше его разбирать не нужно
export async function handleCommand(ctx, cmd, message) {
  if (cmd.target && cmd.target.toLowerCase() !== app.username.toLowerCase()) return true; // чужая команда
  const key = ALIAS[cmd.name];
  if (!key) return false;
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
    case 'tone':
      if (/жёст|жест|hard/i.test(cmd.args)) st.settings.tone = 'hard';
      else if (/мягк|добр|soft/i.test(cmd.args)) st.settings.tone = 'soft';
      else return void (await reply(`Тон сейчас: ${st.settings.tone === 'hard' ? 'жёсткий' : 'мягкий'}. /тон мягко|жёстко`));
      save();
      await reply(st.settings.tone === 'hard' ? 'Окей, буду дерзче 😏' : 'Окей, буду добрее 😇');
      break;
    case 'nojoke':
      st.optOut[from.id] = !st.optOut[from.id];
      save();
      await reply(st.optOut[from.id] ? 'Принято, тебя не трогаю. Повторная команда вернёт всё назад.' : 'Ну всё, ты в игре 😈');
      break;
    case 'life': {
      if (/^(вкл|on|да)/i.test(cmd.args)) st.settings.autonomy = true;
      else if (/^(выкл|off|нет)/i.test(cmd.args)) st.settings.autonomy = false;
      else return void (await reply(`Своя жизнь: ${st.settings.autonomy === false ? 'выкл' : 'вкл'}. /жизнь вкл|выкл`));
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
  await say(chatId, st, res.text.slice(0, 1500));
  return true;
}

export async function sendRevive(chatId, st) {
  const res = await generate({ system: system(st, app.name), prompt: revivePrompt(st.history), maxTokens: 150, temperature: 1 });
  if (!res) return false;
  const poll = res.text.match(/^POLL:\s*(.+)$/im);
  if (poll) {
    const [q, ...opts] = poll[1].split('|').map((s) => s.trim()).filter(Boolean);
    if (q && opts.length >= 2) {
      await app.telegram.sendPoll(chatId, q.slice(0, 250), opts.slice(0, 4).map((o) => o.slice(0, 100)), { is_anonymous: true });
      st.lastReviveAt = Date.now();
      return true;
    }
  }
  const r = parseReply(res.text);
  if (r.type !== 'text') return false;
  await say(chatId, st, r.text);
  st.lastReviveAt = Date.now();
  return true;
}
