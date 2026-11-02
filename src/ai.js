import { config } from './config.js';

// Gemini — основной мозг, Grok — подколы. Если один упёрся в лимит, берём другой; если оба — молчим.

const TIMEOUT_MS = 12_000;
const TOTAL_BUDGET_MS = 30_000; // дольше этого весь перебор моделей не тянем
const cooldown = {}; // ключ «провайдер:модель» -> до какого времени она «отдыхает»
let rr = 0; // счётчик для кругового выбора ключа
const fails = {}; // ключ -> подряд ошибок (пауза растёт: 1, 2, 4, 8, 10 мин)
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
    enabled: () => config.geminiKeys.length > 0,
    // для каждой модели — все ключи, начиная с очередного по кругу (нагрузка делится между аккаунтами)
    variants: (tier, offset) => {
      const models = tier === 'smart' ? [...config.geminiSmartModels, ...config.geminiModels] : config.geminiModels;
      const keys = config.geminiKeys;
      return models.flatMap((model) => keys.map((_, i) => ({ model, apiKey: keys[(offset + i) % keys.length] })));
    },
    supportsMedia: true,
    async call({ system, prompt, maxTokens, temperature, model, json, media, apiKey }) {
      const generationConfig = { maxOutputTokens: maxTokens, temperature };
      if (json) generationConfig.responseMimeType = 'application/json';
      const send = (gc) =>
        post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { 'x-goog-api-key': apiKey },
          {
            systemInstruction: { parts: [{ text: system }] },
            contents: [
              {
                role: 'user',
                parts: [...(media ? [{ inlineData: { mimeType: media.mime, data: media.data } }] : []), { text: prompt }],
              },
            ],
            generationConfig: gc,
          },
        );
      let data;
      // «Размышления» съедают лимит токенов и замедляют короткие реплики — выключаем (у lite их и нет)
      if (!/lite/.test(model)) {
        try {
          data = await send({ ...generationConfig, thinkingConfig: { thinkingBudget: 0 } });
        } catch (e) {
          if (!(e.status === 400 && /think/i.test(e.message))) throw e; // модель не умеет отключать — повторим как есть
        }
      }
      data ??= await send(generationConfig);
      return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    },
  },
  grok: {
    enabled: () => Boolean(config.grokKey),
    variants: () => [{ model: config.grokModel, apiKey: config.grokKey }],
    async call({ system, prompt, maxTokens, temperature, model, apiKey }) {
      const data = await post(
        'https://api.x.ai/v1/chat/completions',
        { authorization: `Bearer ${apiKey}` },
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
  // у каждого ключа Gemini своя квота, поэтому общий лимит растёт с их числом
  const rpm = config.aiRpm * Math.max(1, config.geminiKeys.length);
  const limit = high ? rpm : Math.max(1, Math.floor(rpm * 0.6));
  return calls.length < limit;
}

/**
 * @param {{system:string, prompt:string, maxTokens?:number, temperature?:number,
 *          prefer?:'main'|'edgy', high?:boolean}} o
 * @returns {Promise<{text:string, provider:string}|null>} null = никто не ответил, молчим
 */
export async function generate({ system, prompt, maxTokens = 120, temperature = 0.9, prefer = 'main', high = false, json = false, tier = 'fast', media = null }) {
  if (!rateOk(high)) {
    console.log('[ai] общий лимит запросов в минуту, молчим');
    return null;
  }
  const names = (prefer === 'edgy' ? ['grok', 'gemini'] : ['gemini', 'grok']).filter((n) => providers[n].enabled() && (!media || providers[n].supportsMedia));
  const offset = rr++;
  const seen = new Set();
  const candidates = names
    .flatMap((name) => providers[name].variants(tier, offset).map((v) => ({ name, ...v, id: `${name}:${v.model}:…${String(v.apiKey).slice(-4)}` })))
    .filter((c) => !seen.has(c.id) && seen.add(c.id));
  const started = Date.now();
  for (const { name, model, apiKey, id: key } of candidates) {
    if ((cooldown[key] || 0) > Date.now()) continue;
    if (Date.now() - started > TOTAL_BUDGET_MS) break;
    calls.push(Date.now());
    try {
      const text = (await providers[name].call({ system, prompt, maxTokens, temperature, model, json, media, apiKey })).trim();
      if (text) {
        fails[key] = 0;
        return { text, provider: key };
      }
      console.log(`[ai] ${key}: пустой ответ`);
    } catch (e) {
      const transient = e.status === 429 || e.status >= 500 || e.status === 0;
      fails[key] = (fails[key] || 0) + 1;
      const base = transient ? e.retryAfterMs || 60_000 : 10 * 60_000;
      cooldown[key] = Date.now() + Math.min(10 * 60_000, base * 2 ** (fails[key] - 1));
      console.warn(`[ai] ${key} упал (${e.message.replace(/\s+/g, ' ').slice(0, 120)}); подряд ${fails[key]}, пауза до ${new Date(cooldown[key]).toISOString()}`);
    }
  }
  return null;
}
