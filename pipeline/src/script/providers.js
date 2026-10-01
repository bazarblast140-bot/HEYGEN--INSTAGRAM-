// Which model writes the brief is configuration, not code.
//
// This started as Claude, then a Moonshot key appeared in the secrets, then
// DeepSeek came up. Adding a branch per vendor is a losing game — almost every
// one of them serves the same OpenAI-compatible chat-completions shape, so there
// are exactly two code paths here: Anthropic's, and everyone else's.
//
// To use a vendor that is not listed below, set SCRIPT_BASE_URL, SCRIPT_API_KEY
// and SCRIPT_MODEL. Nothing needs to change in this file.

import { env } from '../../../src/config.js';

/**
 * Known OpenAI-compatible vendors. Each entry only saves the operator from
 * having to know the base URL; none of them is special-cased anywhere else.
 *
 * Model ids move faster than this table. SCRIPT_MODEL always wins, and a 404 from
 * the vendor says so explicitly rather than failing vaguely.
 */
export const VENDORS = {
  moonshot: { key: 'MOONSHOT_API_KEY', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2-0711-preview' },
  deepseek: { key: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  groq:     { key: 'GROQ_API_KEY',     baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  together: { key: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  openrouter: { key: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
};

function openAiVendor(name) {
  const vendor = VENDORS[name];
  return {
    kind: 'openai-compatible',
    name,
    baseUrl: vendor.baseUrl,
    apiKey: env(vendor.key),
    model: env('SCRIPT_MODEL') || vendor.model,
  };
}

/**
 * DeepSeek writes the brief when its key is present. Another vendor is used
 * only when SCRIPT_PROVIDER names it, or when DeepSeek is not configured.
 */
export function resolveProvider() {
  const forced = env('SCRIPT_PROVIDER');

  if (forced === 'anthropic') {
    if (!env('ANTHROPIC_API_KEY')) {
      throw new Error('SCRIPT_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.');
    }
    return { kind: 'anthropic', name: 'anthropic', model: env('SCRIPT_MODEL') || 'claude-fable-5' };
  }

  if (forced && !VENDORS[forced]) {
    throw new Error(`SCRIPT_PROVIDER="${forced}" is unknown. Known: anthropic, ${Object.keys(VENDORS).join(', ')} — or set SCRIPT_BASE_URL + SCRIPT_API_KEY.`);
  }

  if (forced && VENDORS[forced]) {
    if (!env(VENDORS[forced].key)) {
      throw new Error(`SCRIPT_PROVIDER=${forced} but ${VENDORS[forced].key} is not set.`);
    }
    return openAiVendor(forced);
  }

  if (env('DEEPSEEK_API_KEY')) return openAiVendor('deepseek');

  if (env('SCRIPT_BASE_URL') && env('SCRIPT_API_KEY')) {
    return {
      kind: 'openai-compatible',
      name: 'custom',
      baseUrl: env('SCRIPT_BASE_URL'),
      apiKey: env('SCRIPT_API_KEY'),
      model: env('SCRIPT_MODEL') || '',
    };
  }

  for (const name of Object.keys(VENDORS)) {
    if (name === 'deepseek') continue;
    if (!env(VENDORS[name].key)) continue;
    return openAiVendor(name);
  }

  if (env('ANTHROPIC_API_KEY')) {
    return { kind: 'anthropic', name: 'anthropic', model: env('SCRIPT_MODEL') || 'claude-fable-5' };
  }

  return null;
}

/** Pull one JSON object out of a model reply, including a fenced block. */
export function extractJsonObject(text) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* the model wrapped the object in prose */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

/**
 * A line the owner can read in the Actions log.
 * Auth and balance failures are not retried. A missing `segments` array is.
 * The detail is trimmed and any key-shaped token is redacted.
 */
export function describeProviderFailure({ name, status, detail }) {
  const clean = String(detail || 'no detail')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  let kind = 'request';
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 402 || status === 429) kind = 'balance';
  else if (status === 200) kind = 'parse';
  const label = {
    auth: 'auth problem',
    balance: 'balance or rate-limit problem',
    parse: 'parsing problem',
    request: 'request problem',
  }[kind];
  return {
    kind,
    retryable: kind === 'parse' || (kind === 'request' && (!status || status >= 500)),
    message: `${name} HTTP ${status || 'n/a'}: ${label} — ${clean}`,
  };
}

function isDeepSeek(provider) {
  const model = String(provider.model || '').toLowerCase();
  const base = String(provider.baseUrl || '').toLowerCase();
  return provider.name === 'deepseek' || model.includes('deepseek') || base.includes('deepseek.com');
}

/**
 * OpenAI-compatible chat completions in JSON mode.
 *
 * JSON mode guarantees parseable JSON, not a shape, so the schema is checked here
 * rather than enforced by the server. A shape failure carries the field paths so
 * the retry can name what was wrong.
 *
 * DeepSeek V4.x defaults to thinking mode: message.content is often empty and the
 * answer sits in reasoning_content (or never lands). Disable thinking for script
 * generation so JSON mode actually returns JSON in content.
 */
export async function callOpenAICompatible({ provider, system, user, schema }) {
  const baseUrl = provider.baseUrl.replace(/\/$/, '');
  const deepseek = isDeepSeek(provider);

  const body = {
    model: provider.model,
    max_tokens: 8000,
    temperature: 0.6,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  // V4 Flash / Pro: thinking on by default → empty content with --require-generated.
  if (deepseek) {
    body.thinking = { type: 'disabled' };
  }

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const failure = describeProviderFailure({
      name: provider.name, status: null, detail: err.message,
    });
    throw Object.assign(new Error(failure.message), { retryable: true, httpStatus: null });
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.error?.message || payload?.message || 'no error body';
    const failure = describeProviderFailure({ name: provider.name, status: res.status, detail });
    throw Object.assign(new Error(failure.message), {
      retryable: failure.retryable,
      httpStatus: res.status,
    });
  }

  const msg = payload?.choices?.[0]?.message || {};
  let parsed = extractJsonObject(msg.content);
  // Thinking models sometimes leave content empty, or return a stub object,
  // and put the spec in reasoning_content.
  if ((!parsed || parsed.segments == null) && typeof msg.reasoning_content === 'string') {
    const fromReasoning = extractJsonObject(msg.reasoning_content);
    if (fromReasoning && (fromReasoning.segments || fromReasoning.slides)) parsed = fromReasoning;
  }
  if (!parsed) {
    const failure = describeProviderFailure({
      name: provider.name, status: res.status, detail: 'empty body',
    });
    throw Object.assign(new Error(failure.message), {
      retryable: true,
      httpStatus: res.status,
      schemaIssues: ['empty body'],
    });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    const keys = Object.keys(parsed).slice(0, 8).join(', ') || 'none';
    const failure = describeProviderFailure({
      name: provider.name,
      status: res.status,
      detail: `${issues.join('; ')} (body keys: ${keys})`,
    });
    throw Object.assign(new Error(failure.message), {
      retryable: true,
      httpStatus: res.status,
      schemaIssues: issues,
    });
  }

  return { output: result.data, model: provider.model };
}
