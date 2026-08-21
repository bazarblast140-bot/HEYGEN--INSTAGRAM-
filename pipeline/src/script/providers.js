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
  deepseek: { key: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  groq:     { key: 'GROQ_API_KEY',     baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  together: { key: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  openrouter: { key: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
};

/**
 * Resolve who writes the script, from whatever is configured.
 * Anthropic wins when present, because the schema is enforced server-side there
 * rather than validated after the fact.
 */
export function resolveProvider() {
  const forced = env('SCRIPT_PROVIDER');

  if (env('ANTHROPIC_API_KEY') && (!forced || forced === 'anthropic')) {
    return { kind: 'anthropic', name: 'anthropic', model: env('SCRIPT_MODEL') || 'claude-fable-5' };
  }

  // A fully explicit endpoint beats every guess.
  if (env('SCRIPT_BASE_URL') && env('SCRIPT_API_KEY')) {
    return {
      kind: 'openai-compatible',
      name: env('SCRIPT_PROVIDER') || 'custom',
      baseUrl: env('SCRIPT_BASE_URL'),
      apiKey: env('SCRIPT_API_KEY'),
      model: env('SCRIPT_MODEL') || '',
    };
  }

  const candidates = forced ? [forced] : Object.keys(VENDORS);
  for (const name of candidates) {
    const vendor = VENDORS[name];
    if (!vendor) throw new Error(`SCRIPT_PROVIDER="${name}" is unknown. Known: anthropic, ${Object.keys(VENDORS).join(', ')} — or set SCRIPT_BASE_URL + SCRIPT_API_KEY.`);
    const apiKey = env(vendor.key);
    if (!apiKey) continue;
    return {
      kind: 'openai-compatible',
      name,
      baseUrl: env('SCRIPT_BASE_URL') || vendor.baseUrl,
      apiKey,
      model: env('SCRIPT_MODEL') || vendor.model,
    };
  }

  return null;
}

/**
 * OpenAI-compatible chat completions in JSON mode.
 *
 * JSON mode guarantees parseable JSON, not a shape, so the schema is checked here
 * rather than enforced by the server. A shape failure carries the field paths so
 * the retry can name what was wrong.
 */
export async function callOpenAICompatible({ provider, system, user, schema }) {
  const baseUrl = provider.baseUrl.replace(/\/$/, '');

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 8000,
      temperature: 0.6,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.error?.message || `HTTP ${res.status}`;
    if (res.status === 404 || /model/i.test(detail)) {
      throw new Error(`${provider.name} rejected model "${provider.model}" (${detail}). Set the SCRIPT_MODEL variable to a model id your account has.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${provider.name} rejected the key (${detail}). Check the ${VENDORS[provider.name]?.key || 'SCRIPT_API_KEY'} secret.`);
    }
    throw new Error(`${provider.name} request failed: ${detail}`);
  }

  const text = payload?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${provider.name} returned no content`);

  let parsed;
  try {
    // JSON mode should make fences impossible, but strip them rather than lose
    // the run to a stray ```json.
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error(`${provider.name} returned unparseable JSON: ${text.slice(0, 160)}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 6).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw Object.assign(new Error(`${provider.name} output did not match the schema — ${issues.join('; ')}`), { schemaIssues: issues });
  }

  return { output: result.data, model: provider.model };
}
