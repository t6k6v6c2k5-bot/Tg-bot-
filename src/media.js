import { config } from './config.js';
import { generate } from './ai.js';
import { app } from './respond.js';

// Голосовые и кружки расшифровываем, фото описываем (Gemini понимает аудио и картинки).
// Результат кладётся в историю как текст, поэтому попадает в статистику, пересказы и память.

const H = 3600_000;
const MAX_SPEECH_SEC = 180;
const MAX_SPEECH_BYTES = 5_000_000;
const MAX_PHOTO_BYTES = 3_000_000;

export function mediaKind(m) {
  if (m.voice || m.audio || m.video_note) return 'speech';
  if (m.photo?.length) return 'photo';
  return null;
}

export const label = (m) =>
  m.photo ? '[фото]'
  : m.sticker ? `[стикер ${m.sticker.emoji || ''}]`
  : m.voice ? '[голосовое]'
  : m.video_note ? '[кружок]'
  : m.video ? '[видео]'
  : m.animation ? '[гифка]'
  : m.audio ? '[музыка]'
  : m.document ? '[файл]'
  : m.poll ? `[опрос: ${m.poll.question}]`
  : m.location ? '[геопозиция]'
  : m.contact ? '[контакт]'
  : null;

// Самый крупный вариант фото, который укладывается в лимит
export function pickPhoto(sizes, max = MAX_PHOTO_BYTES) {
  const ok = sizes.filter((p) => !p.file_size || p.file_size <= max);
  return (ok.length ? ok : sizes.slice(0, 1)).at(-1);
}

export function mediaBudgetOk(st, now) {
  st.mediaLog = (st.mediaLog || []).filter((t) => now - t < H);
  return config.mediaEnabled && st.mediaLog.length < config.mediaPerHour;
}

async function download(fileId, maxBytes) {
  const link = await app.telegram.getFileLink(fileId);
  const res = await fetch(link.href);
  if (!res.ok) throw new Error(`скачивание: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) return null;
  return buf.toString('base64');
}

const clean = (t, n) => t.replace(/\s+/g, ' ').replace(/^["«“]+|["»”]+$/g, '').trim().slice(0, n);

// Расшифровка через Whisper на Groq: быстро и не тратит квоту Gemini
async function whisper(b64, filename, mime) {
  for (const key of config.groqKeys) {
    try {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from(b64, 'base64')], { type: mime }), filename);
      form.append('model', config.groqWhisperModel);
      form.append('response_format', 'json');
      form.append('temperature', '0');
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 100)}`);
      return ((await res.json()).text || '').trim();
    } catch (e) {
      console.warn(`[whisper] ключ …${key.slice(-4)}: ${e.message}`);
    }
  }
  return null;
}

// → текст расшифровки или null
export async function transcribe(m) {
  const f = m.voice || m.audio || m.video_note;
  if ((f.duration || 0) > MAX_SPEECH_SEC || (f.file_size || 0) > MAX_SPEECH_BYTES) return null;
  const data = await download(f.file_id, MAX_SPEECH_BYTES);
  if (!data) return null;
  const mime = m.voice ? 'audio/ogg' : m.video_note ? 'video/mp4' : f.mime_type || 'audio/mpeg';
  if (config.groqKeys.length) {
    const ext = m.voice ? 'ogg' : m.video_note ? 'mp4' : (f.file_name || '').split('.').pop() || 'mp3';
    const t = await whisper(data, `audio.${ext}`, mime);
    if (t != null) return t ? clean(t, 600) : null; // Groq ответил: пусто = речи нет
  }
  const res = await generate({
    system: 'Ты точный транскрибатор. Отвечай только текстом расшифровки, без пояснений.',
    prompt: 'Расшифруй речь из этого сообщения дословно, на языке оригинала. Если речи нет или она неразборчива — верни пустой ответ.',
    media: { mime, data },
    maxTokens: 500,
    temperature: 0.1,
  });
  const t = res ? clean(res.text, 600) : '';
  return t && !/^(пусто|нет речи|\.+)$/i.test(t) ? t : null;
}

// → короткое описание картинки или null
export async function describePhoto(m) {
  const p = pickPhoto(m.photo);
  const data = await download(p.file_id, MAX_PHOTO_BYTES);
  if (!data) return null;
  const res = await generate({
    system: 'Ты кратко и точно описываешь картинки для чата. Только факты, без оценок.',
    prompt:
      'Опиши, что на картинке, одной строкой (до 18 слов). Если это мем — перескажи суть шутки и текст на нём. Скриншот — о чём он. ' +
      'Внешность людей не описывай (лица, тело, возраст), только что происходит и что изображено. Если описывать нечего — верни пустой ответ.',
    media: { mime: 'image/jpeg', data },
    maxTokens: 120,
    temperature: 0.2,
  });
  const t = res ? clean(res.text, 220) : '';
  return t || null;
}
