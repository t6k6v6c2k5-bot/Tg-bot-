import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GROQ_API_KEY = 'gsk_media_1111';
process.env.GEMINI_API_KEY = 'gem-key';
const { app } = await import('../src/respond.js');
const { transcribe } = await import('../src/media.js');

test('голосовое расшифровывается через Whisper на Groq, Gemini не трогаем', async () => {
  const hits = [];
  app.telegram = { getFileLink: async (id) => ({ href: `https://tg.test/${id}` }) };
  globalThis.fetch = async (url, opts) => {
    hits.push(url);
    if (url.startsWith('https://tg.test/')) return new Response(Buffer.from('OggS-fake-audio'));
    if (url.includes('/audio/transcriptions')) {
      assert.match(opts.headers.authorization, /^Bearer gsk_media_/);
      assert.ok(opts.body instanceof FormData);
      assert.equal(opts.body.get('model'), 'whisper-large-v3-turbo');
      assert.equal(opts.body.get('file').name, 'audio.ogg');
      return new Response(JSON.stringify({ text: ' Батя, посоветуй ужин ' }));
    }
    throw new Error('неожиданный запрос: ' + url);
  };
  const t = await transcribe({ voice: { file_id: 'v1', duration: 5, file_size: 1000 } });
  assert.equal(t, 'Батя, посоветуй ужин');
  assert.ok(!hits.some((u) => u.includes('googleapis')));
});

test('Whisper вернул пустоту — речи нет, null', async () => {
  globalThis.fetch = async (url) => (url.startsWith('https://tg.test/') ? new Response(Buffer.from('x')) : new Response(JSON.stringify({ text: '' })));
  assert.equal(await transcribe({ voice: { file_id: 'v2', duration: 2, file_size: 100 } }), null);
});
