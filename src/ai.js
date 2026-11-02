import { config } from './config.js';

// Gemini — основной мозг, Grok — подколы. Если один упёрся в лимит, берём другой; если оба — молчим.

const TIMEOUT_MS = 15_000;
const cooldown = {}; // ключ «провайдер:модель» -> до какого времени она «отдыхает»
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
    models: () => config.geminiModels,
    async call({ system, prompt, maxTokens, temperature, model, json }) {
      const generationConfig = { maxOutputTokens: maxTokens, temperature };
      if (json) generationConfig.responseMimeType = 'application/json';
      // у 2.5 Flash «размышления» съедают лимит токенов — для коротких реплик не нужны
      if (/2\.5-flash(?!-lite)/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const data = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
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
    models: () => [config.grokModel],
    async call({ system, prompt, maxTokens, temperature, model }) {
      const data = await post(
        'https://api.x.ai/v1/chat/completions',
        { authorization: `Bearer ${config.grokKey}` },
        {
          model,
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
export async function generate({ system, prompt, maxTokens = 120, temperature = 0.9, prefer = 'main', high = false, json = false }) {
  if (!rateOk(high)) {
    console.log('[ai] общий лимит запросов в минуту, молчим');
    return null;
  }
  const names = (prefer === 'edgy' ? ['grok', 'gemini'] : ['gemini', 'grok']).filter((n) => providers[n].enabled());
  const candidates = names.flatMap((name) => providers[name].models().map((model) => ({ name, model })));
  for (const { name, model } of candidates) {
    const key = `${name}:${model}`;
    if ((cooldown[key] || 0) > Date.now()) continue;
    calls.push(Date.now());
    try {
      const text = (await providers[name].call({ system, prompt, maxTokens, temperature, model, json })).trim();
      if (text) return { text, provider: key };
      console.log(`[ai] ${key}: пустой ответ`);
    } catch (e) {
      const limited = e.status === 429 || e.status >= 500 || e.status === 0;
      cooldown[key] = Date.now() + (limited ? e.retryAfterMs || 60_000 : 10 * 60_000);
      console.warn(`[ai] ${key} упал (${e.message.replace(/\s+/g, ' ').slice(0, 160)}); пауза до ${new Date(cooldown[key]).toISOString()}`);
    }
  }
  return null;
}
