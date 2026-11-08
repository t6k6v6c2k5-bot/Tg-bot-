import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Хозяин бота (админ): привязка Telegram-ID и режим «со мной серьёзно». Хранится в admin.json на Volume.
const file = () => path.join(config.dataDir, 'admin.json');
let state = null; // { ids:Set, serious:boolean }

function load() {
  if (state) return state;
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    state = { ids: new Set(j.ids || []), serious: j.serious !== false, off: j.off === true, selfTalk: typeof j.selfTalk === 'boolean' ? j.selfTalk : undefined };
  } catch {
    state = { ids: new Set(), serious: true, off: false, selfTalk: undefined };
  }
  return state;
}

function persist() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ ids: [...state.ids], serious: state.serious, off: state.off, selfTalk: state.selfTalk }));
  } catch (e) {
    console.error('[admin] не удалось сохранить:', e.message);
  }
}

export const isAdminId = (id) => Boolean(id) && (config.adminIds.includes(id) || load().ids.has(id));
export const hasAdmins = () => config.adminIds.length > 0 || load().ids.size > 0;

export function bindAdmin(id) {
  load().ids.add(id);
  persist();
  console.log(`[admin] админ привязан к Telegram-ID ${id}`);
}

/** С админом говорим серьёзно, без шуток (по умолчанию включено). */
export const ownerSerious = () => load().serious;
export function setOwnerSerious(v) {
  load().serious = Boolean(v);
  persist();
}

/** Полный выключатель: бот молчит везде и ничего не делает сам, пока админ не включит. */
export const botOff = () => load().off === true;
export function setBotOff(v) {
  load().off = Boolean(v);
  persist();
}

/** Может ли бот сам писать в чат. По умолчанию нет (SELF_TALK=1 включает); переключается в админке. */
export const selfTalk = () => load().selfTalk ?? config.selfTalk;
export function setSelfTalk(v) {
  load().selfTalk = Boolean(v);
  persist();
}

export const _resetOwner = () => (state = null);
