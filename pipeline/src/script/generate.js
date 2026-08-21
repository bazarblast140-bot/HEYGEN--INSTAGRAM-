// Turn a day's market data into a reel spec.
//
// Structured outputs do the enforcement: the schema below is the contract, so a
// beat that is missing a caption or that invents a beat type fails at the API
// rather than three stages downstream in ffmpeg.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from '../../../src/config.js';
import { SYSTEM, buildUserPrompt } from './prompt.js';
import { resolveProvider, callOpenAICompatible, VENDORS } from './providers.js';

const Stat = z.object({
  value: z.string(),
  label: z.string(),
  direction: z.enum(['up', 'down', 'flat']),
});

const Card = z.object({
  chips: z.array(z.string()),
  headline: z.string(),
  power: z.string(),
  stat: Stat.nullable(),
  footnote: z.string(),
});

const Beat = z.object({
  type: z.enum(['hook', 'cutin', 'chart', 'card']),
  seconds: z.number().nullable(),
  say: z.string(),
  caption: z.string(),
  power: z.string(),
  card: Card.nullable(),
});

const ReelSpec = z.object({
  verdict: z.string(),
  segments: z.array(Beat),
  body: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
});

export const MODEL = env('SCRIPT_MODEL') || 'claude-fable-5';

/**
 * Structural checks the schema cannot express. A spec that passes validation but
 * runs to fifty seconds, or has no presenter beat, is still not a reel — and
 * finding that out here costs one retry rather than a whole render.
 */
function validateShape(spec) {
  const problems = [];
  // Runtime is set by how long the narration actually takes, so the check is on
  // the words rather than on numbers the model guessed.
  const words = spec.segments.reduce((n, s) => n + String(s.say || '').trim().split(/\s+/).filter(Boolean).length, 0);

  if (words < 55 || words > 115) problems.push(`${words} spoken words is outside 55–115 (about 22–40 seconds)`);
  if (!spec.segments.some((s) => s.type === 'hook')) problems.push('no hook beat');
  if (!spec.segments.some((s) => s.type === 'chart')) problems.push('no chart beat');

  for (const [i, beat] of spec.segments.entries()) {
    const where = `beat ${i} (${beat.type})`;
    const beatWords = String(beat.say || '').trim().split(/\s+/).filter(Boolean).length;
    if (beatWords > 26) problems.push(`${where}: ${beatWords} spoken words is too long for one shot`);
    if (!beat.say?.trim()) problems.push(`${where}: needs "say" — every beat is narrated`);
    if (beat.type !== 'chart' && !beat.card) problems.push(`${where}: needs a card`);
    if (beat.caption.split(/\s+/).length > 12) problems.push(`${where}: caption is over 12 words`);
  }

  return problems;
}

async function callAnthropic({ system, user, model, effort }) {
  const client = new Anthropic();

  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    system,
    // Fable 5 thinks by default; effort is the depth control, and budget_tokens
    // and temperature are both rejected on this model.
    output_config: { effort, format: zodOutputFormat(ReelSpec) },
    // A policy decline would otherwise end the run with no brief at all.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Script generation was declined (${response.stop_details?.category || 'no category'})`);
  }

  return { output: response.parsed_output, model };
}

export async function generateSpec({
  market,
  news,
  date = new Date().toISOString().slice(0, 10),
  model,
  effort = 'high',
  onAttempt,
}) {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error(
      'No script model configured. Set ANTHROPIC_API_KEY, or one of ' +
      `${Object.values(VENDORS).map((v) => v.key).join(' / ')}, or SCRIPT_BASE_URL + SCRIPT_API_KEY.`,
    );
  }

  const chosenModel = model || provider.model;
  if (!chosenModel) throw new Error(`${provider.name}: no model chosen. Set the SCRIPT_MODEL variable.`);

  let lastProblems = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let userPrompt = buildUserPrompt({ market, news, date });

    // A second pass is given the specific complaints rather than being asked
    // again and hoped at.
    if (lastProblems.length) {
      userPrompt += `\n\nYour previous attempt was rejected:\n${lastProblems.map((p) => `- ${p}`).join('\n')}\nFix exactly these and return the full spec again.`;
    }

    onAttempt?.(attempt, `${provider.name}/${chosenModel}`);

    try {
      const { output, model: used } = provider.kind === 'anthropic'
        ? await callAnthropic({ system: SYSTEM, user: userPrompt, model: chosenModel, effort })
        : await callOpenAICompatible({
            provider: { ...provider, model: chosenModel },
            system: SYSTEM, user: userPrompt, schema: ReelSpec,
          });

      lastProblems = validateShape(output);
      if (!lastProblems.length) return { spec: output, provider: provider.name, model: used, attempts: attempt };
    } catch (err) {
      // A schema mismatch is worth one more pass with the field paths attached;
      // an auth or model-name failure is not going to fix itself.
      if (!err.schemaIssues || attempt === 2) throw err;
      lastProblems = err.schemaIssues;
    }
  }

  throw new Error(`Generated spec still invalid after 2 attempts: ${lastProblems.join('; ')}`);
}
