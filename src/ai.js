import { config } from './config.js';

// Gemini — основной мозг, Grok — подколы. Если один упёрся в лимит, берём другой; если оба — молчим.

const TIMEOUT_MS = 15_000;
const cooldown = { gemini: 0, grok: 0 }; // до какого времени провайдер «отдыхает»
const calls = []; // ts вызовов за последнюю минуту

class ProviderError extends Error {
  constructor(msg, status, retryAfterMs) {
    super(msg);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

async function post(url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      const detail = (await res.text()).slice(0, 200);
      throw new ProviderError(`HTTP ${res.status} ${detail}`, res.status, ra ? ra * 1000 : 0);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(e.name === 'AbortError' ? 'timeout' : e.message, 0, 0);
  } finally {
    clearTimeout(timer);
  }
}

const providers = {
  gemini: {
    enabled: () => Boolean(config.geminiKey),
    async call({ system, prompt, maxTokens, temperature }) {
      const generationConfig = { maxOutputTokens: maxTokens, temperature };
      // у 2.5 Flash «размышления» съедают лимит токенов — для коротких реплик не нужны
      if (/2\.5-flash/.test(config.geminiModel)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const data = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`,
        { 'x-goog-api-key': config.geminiKey },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig,
        },
      );
      return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    },
  },
  grok: {
    enabled: () => Boolean(config.grokKey),
    async call({ system, prompt, maxTokens, temperature }) {
      const data = await post(
        'https://api.x.ai/v1/chat/completions',
        { authorization: `Bearer ${config.grokKey}` },
        {
          model: config.grokModel,
          max_tokens: maxTokens,
          temperature,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        },
      );
      return data.choices?.[0]?.message?.content ?? '';
    },
  },
};

function rateOk(high) {
  const now = Date.now();
  while (calls.length && now - calls[0] > 60_000) calls.shift();
  // часть лимита зарезервирована под прямые обращения к боту
  const limit = high ? config.aiRpm : Math.max(1, Math.floor(config.aiRpm * 0.6));
  return calls.length < limit;
}

/**
 * @param {{system:string, prompt:string, maxTokens?:number, temperature?:number,
 *          prefer?:'main'|'edgy', high?:boolean}} o
 * @returns {Promise<{text:string, provider:string}|null>} null = никто не ответил, молчим
 */
export async function generate({ system, prompt, maxTokens = 120, temperature = 0.9, prefer = 'main', high = false }) {
  if (!rateOk(high)) {
    console.log('[ai] общий лимит запросов в минуту, молчим');
    return null;
  }
  const order = (prefer === 'edgy' ? ['grok', 'gemini'] : ['gemini', 'grok']).filter((n) => providers[n].enabled());
  for (const name of order) {
    if (cooldown[name] > Date.now()) continue;
    calls.push(Date.now());
    try {
      const text = (await providers[name].call({ system, prompt, maxTokens, temperature })).trim();
      if (text) return { text, provider: name };
      console.log(`[ai] ${name}: пустой ответ`);
    } catch (e) {
      const limited = e.status === 429 || e.status >= 500 || e.status === 0;
      cooldown[name] = Date.now() + (limited ? e.retryAfterMs || 60_000 : 10 * 60_000);
      console.warn(`[ai] ${name} упал (${e.message}); пауза до ${new Date(cooldown[name]).toISOString()}`);
    }
  }
  return null;
}
