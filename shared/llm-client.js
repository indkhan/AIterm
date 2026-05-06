export const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyHelpUrl: 'https://aistudio.google.com/app/apikey',
    modelPreference: [
      'gemini-3.1-flash-lite',
      'gemini-3.1-pro-preview',
      'gemini-3-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ],
    chatModelPreference: [
      'gemini-3.1-flash-lite',
      'gemini-3-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
    ],
  },
};

export function resolveBaseUrl({ provider, baseUrlOverride }) {
  if (baseUrlOverride && baseUrlOverride.trim()) {
    return baseUrlOverride.trim().replace(/\/$/, '');
  }
  const config = PROVIDERS[provider];
  if (!config) throw normalizedError('config', `Unknown provider: ${provider}`);
  return config.defaultBaseUrl;
}

function normalizedError(code, message, retryAfter) {
  const error = new Error(message);
  error.code = code;
  if (retryAfter) error.retryAfter = retryAfter;
  return error;
}

async function fetchWithTimeout(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: options.signal || controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw normalizedError('network', 'Request timed out');
    }
    throw normalizedError('network', error.message || 'Network error');
  } finally {
    clearTimeout(timer);
  }
}

async function parseErrorResponse(response) {
  let body = '';
  try {
    body = await response.text();
  } catch (_e) {
    /* ignore */
  }

  let message = `${response.status} ${response.statusText}`;
  try {
    const json = JSON.parse(body);
    message = json?.error?.message || json?.error || message;
  } catch (_e) {
    if (body) message = body.slice(0, 500);
  }

  if (response.status === 401 || response.status === 403) {
    return normalizedError('auth', `API key rejected: ${message}`);
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    return normalizedError('rate_limit', `Rate limited: ${message}`, retryAfter);
  }
  return normalizedError('network', message);
}

export async function callLLM({
  provider,
  apiKey,
  model,
  messages,
  jsonMode = false,
  maxTokens = 1500,
  temperature = 0.2,
  baseUrlOverride,
  signal,
  timeoutMs = 90000,
}) {
  if (!apiKey) throw normalizedError('auth', 'API key is missing. Open settings to add one.');
  if (!model) throw normalizedError('config', 'No model selected. Open settings to choose one.');

  const base = resolveBaseUrl({ provider, baseUrlOverride });
  const url = `${base}/chat/completions`;
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    },
    timeoutMs,
  );

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  const payload = await response.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw normalizedError('parse', 'Unexpected response shape from provider');
  }

  return {
    content,
    usage: payload?.usage || null,
    model: payload?.model || model,
  };
}

export async function listModels({ provider, apiKey, baseUrlOverride, signal, timeoutMs = 30000 }) {
  if (!apiKey) throw normalizedError('auth', 'API key is missing.');
  const base = resolveBaseUrl({ provider, baseUrlOverride });
  const response = await fetchWithTimeout(
    `${base}/models`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    },
    timeoutMs,
  );

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  const payload = await response.json().catch(() => ({}));
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data
    .map((entry) => entry?.id)
    .filter((id) => typeof id === 'string' && id.length > 0)
    .sort();
}

export function pickRecommendedModel(provider, availableModels, kind = 'analysis') {
  const config = PROVIDERS[provider];
  if (!config) return availableModels[0] || '';
  const preference = kind === 'chat' ? config.chatModelPreference : config.modelPreference;
  for (const candidate of preference) {
    if (availableModels.includes(candidate)) return candidate;
  }
  return availableModels[0] || '';
}

export function parseJsonContent(content) {
  if (typeof content !== 'string') {
    throw normalizedError('parse', 'Empty model response');
  }
  try {
    return JSON.parse(content);
  } catch (_first) {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_second) {
        /* fall through */
      }
    }
    throw normalizedError('parse', 'Model response was not valid JSON');
  }
}
