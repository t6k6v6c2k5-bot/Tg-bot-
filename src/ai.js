import { config } from './config.js';

// Gemini — основной мозг, Grok — подколы. Если один упёрся в лимит, берём другой; если оба — молчим.

const TIMEOUT_MS = 9_000;
const TOTAL_BUDGET_MS = 30_000; // дольше этого весь перебор моделей не тянем
// Паузы двух видов: «k:…» — проблема ключа (квота 429, неверный ключ), «m:…» — проблема модели (таймаут, 5xx, нет такой модели)
const cooldown = {};
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
      const full = await res.text();
      // Google в теле 429 пишет RetryInfo: «повторить через 69990s» (суточная квота) — слушаемся, а не долбим каждые минуты
      const rd = Number((full.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) || [])[1]);
      throw new ProviderError(`HTTP ${res.status} ${full.slice(0, 200)}`, res.status, Math.max(ra ? ra * 1000 : 0, rd ? rd * 1000 : 0));
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
  anthropic: {
    enabled: () => config.anthropicKeys.length > 0,
    variants: (tier, offset) => {
      const models = tier === 'smart' ? [config.anthropicSmartModel, config.anthropicModel] : [config.anthropicModel];
      const keys = config.anthropicKeys;
      return [...new Set(models)].flatMap((model) => keys.map((_, i) => ({ model, apiKey: keys[(offset + i) % keys.length] })));
    },
    async call({ system, prompt, maxTokens, temperature, model, json, apiKey }) {
      const data = await post(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        {
          model,
          max_tokens: maxTokens,
          temperature: Math.min(1, temperature),
          system: json ? `${system}\n\nВерни ТОЛЬКО валидный JSON без пояснений и без markdown.` : system,
          messages: [{ role: 'user', content: prompt }],
        },
      );
      return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    },
  },
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
  groq: {
    enabled: () => config.groqKeys.length > 0,
    variants: (_tier, offset) => {
      const keys = config.groqKeys;
      return config.groqModels.flatMap((model) => keys.map((_, i) => ({ model, apiKey: keys[(offset + i) % keys.length] })));
    },
    async call({ system, prompt, maxTokens, temperature, model, json, apiKey }) {
      const data = await post(
        'https://api.groq.com/openai/v1/chat/completions',
        { authorization: `Bearer ${apiKey}` },
        {
          model,
          max_tokens: maxTokens,
          temperature,
          // у gpt-oss принудительный JSON-режим капризен (400 «Failed to generate JSON»): просим JSON в промпте, разбор терпимый
          ...(json && !/gpt-oss/.test(model) ? { response_format: { type: 'json_object' } } : {}),
          // «размышления» отключаем/ужимаем, иначе они съедают лимит токенов короткой реплики
          ...(/qwen/.test(model) ? { reasoning_effort: 'none' } : /gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        },
      );
      return (data.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
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

// Универсальный OpenAI-совместимый провайдер (Mistral, Cerebras, OpenRouter, GitHub Models и т. п.)
function compat(cfg) {
  return {
    enabled: () => cfg.keys.length > 0,
    variants: (_tier, offset) => cfg.models.flatMap((model) => cfg.keys.map((_, i) => ({ model, apiKey: cfg.keys[(offset + i) % cfg.keys.length] }))),
    async call({ system, prompt, maxTokens, temperature, model, apiKey }) {
      const data = await post(
        `${cfg.baseUrl}/chat/completions`,
        { authorization: `Bearer ${apiKey}`, 'x-title': 'tg-chat-buddy' },
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
      return (data.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
    },
  };
}
for (const cfg of config.extraProviders) providers[cfg.name] = compat(cfg);
const extraNames = () => config.extraProviders.map((c) => c.name);

function rateOk(high) {
  const now = Date.now();
  while (calls.length && now - calls[0] > 60_000) calls.shift();
  // часть лимита зарезервирована под прямые обращения к боту
  // у каждого ключа Gemini своя квота, поэтому общий лимит растёт с их числом
  const rpm = config.aiRpm * Math.max(1, config.geminiKeys.length + config.anthropicKeys.length + config.groqKeys.length + config.extraProviders.reduce((n, c) => n + c.keys.length, 0));
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
  const names = (prefer === 'edgy' ? ['anthropic', 'grok', 'groq', ...extraNames(), 'gemini'] : ['anthropic', 'gemini', 'groq', ...extraNames(), 'grok']).filter((n) => providers[n].enabled() && (!media || providers[n].supportsMedia));
  const offset = rr++;
  const seen = new Set();
  const candidates = names
    .flatMap((name) => providers[name].variants(tier, offset).map((v) => ({ name, ...v, id: `${name}:${v.model}:…${String(v.apiKey).slice(-4)}` })))
    .filter((c) => !seen.has(c.id) && seen.add(c.id));
  const started = Date.now();
  for (const { name, model, apiKey, id } of candidates) {
    const mk = `m:${name}:${model}`; // модель перегружена — на всех ключах сразу
    const kk = `k:${id}`; // квота именно этого ключа на этой модели
    if ((cooldown[mk] || 0) > Date.now() || (cooldown[kk] || 0) > Date.now()) continue;
    if (Date.now() - started > TOTAL_BUDGET_MS) break;
    calls.push(Date.now());
    try {
      const text = (await providers[name].call({ system, prompt, maxTokens, temperature, model, json, media, apiKey })).trim();
      if (text) {
        fails[mk] = fails[kk] = 0;
        lastServed = { provider: name, model, id, at: Date.now() };
        return { text, provider: id };
      }
      console.log(`[ai] ${id}: пустой ответ`);
    } catch (e) {
      // 400 про сам запрос (не удалось собрать JSON и т.п.) — не повод отключать модель для всех остальных запросов
      if (e.status === 400 && /failed to generate json|json/i.test(e.message) && !/api key/i.test(e.message)) {
        console.warn(`[ai] ${id}: 400 по формату запроса (${e.message.replace(/\s+/g, ' ').slice(0, 80)}); модель не отключаю`);
        continue;
      }
      const keyProblem = e.status === 429 || e.status === 401 || e.status === 403 || (e.status === 400 && /api key/i.test(e.message));
      const bucket = keyProblem ? kk : mk;
      fails[bucket] = (fails[bucket] || 0) + 1;
      const transient = e.status === 429 || e.status >= 500 || e.status === 0;
      const base = transient ? e.retryAfterMs || 60_000 : 10 * 60_000;
      // если сервер сам назвал длинное время ожидания (суточная квота), ждём ровно столько, иначе растущая пауза до 10 минут
      cooldown[bucket] = Date.now() + (e.retryAfterMs > 10 * 60_000 ? Math.min(e.retryAfterMs, 24 * 3600_000) : Math.min(10 * 60_000, base * 2 ** (fails[bucket] - 1)));
      console.warn(`[ai] ${id} упал (${e.message.replace(/\s+/g, ' ').slice(0, 110)}); ${keyProblem ? 'ключ' : 'модель'}, подряд ${fails[bucket]}, пауза до ${new Date(cooldown[bucket]).toISOString()}`);
    }
  }
  return null;
}

let lastServed = null;
/** Кто реально ответил последним: провайдер, модель, когда. */
export const servedInfo = () => lastServed;

/** Состояние провайдеров для админки: ключи, паузы, нагрузка. */
export function aiStatus(now = Date.now()) {
  const pauses = Object.entries(cooldown)
    .filter(([, until]) => until > now)
    .map(([id, until]) => ({ id, seconds: Math.ceil((until - now) / 1000), fails: fails[id] || 0 }))
    .sort((a, b) => b.seconds - a.seconds);
  while (calls.length && now - calls[0] > 60_000) calls.shift();
  return {
    anthropic: { keys: config.anthropicKeys.length, models: [...new Set([config.anthropicSmartModel, config.anthropicModel])] },
    gemini: { keys: config.geminiKeys.length, models: [...new Set([...config.geminiSmartModels, ...config.geminiModels])] },
    groq: { keys: config.groqKeys.length, models: config.groqModels },
    extra: config.extraProviders.map((c) => ({ name: c.name, keys: c.keys.length, models: c.models })),
    grok: { enabled: Boolean(config.grokKey) },
    callsLastMinute: calls.length,
    pauses,
  };
}
