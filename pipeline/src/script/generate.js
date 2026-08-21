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
  seconds: z.number(),
  say: z.string().nullable(),
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
  const total = spec.segments.reduce((n, s) => n + s.seconds, 0);

  if (total < 22 || total > 36) problems.push(`total runtime ${total.toFixed(1)}s is outside 22–36s`);
  if (!spec.segments.some((s) => s.type === 'hook')) problems.push('no hook beat');
  if (!spec.segments.some((s) => s.type === 'chart')) problems.push('no chart beat');

  for (const [i, beat] of spec.segments.entries()) {
    const where = `beat ${i} (${beat.type})`;
    if (beat.seconds < 2 || beat.seconds > 6) problems.push(`${where}: ${beat.seconds}s is outside 2–6s`);
    if ((beat.type === 'hook' || beat.type === 'cutin') && !beat.say?.trim()) problems.push(`${where}: needs "say"`);
    if (beat.type !== 'chart' && !beat.card) problems.push(`${where}: needs a card`);
    if (beat.caption.split(/\s+/).length > 12) problems.push(`${where}: caption is over 12 words`);
  }

  return problems;
}

export async function generateSpec({
  market,
  news,
  date = new Date().toISOString().slice(0, 10),
  model = MODEL,
  effort = 'high',
  onAttempt,
}) {
  const client = new Anthropic();

  let lastProblems = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let userPrompt = buildUserPrompt({ market, news, date });

    // A second pass is given the specific structural complaints rather than being
    // asked again and hoped at.
    if (lastProblems.length) {
      userPrompt += `\n\nYour previous attempt was rejected:\n${lastProblems.map((p) => `- ${p}`).join('\n')}\nFix exactly these and return the full spec again.`;
    }

    onAttempt?.(attempt, model);

    const response = await client.messages.parse({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      // Fable 5 thinks by default; effort is the depth control, and budget_tokens
      // and temperature are both rejected on this model.
      output_config: { effort, format: zodOutputFormat(ReelSpec) },
      // A policy decline would otherwise end the run with no brief at all.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: userPrompt }],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error(`Script generation was declined (${response.stop_details?.category || 'no category'})`);
    }

    const spec = response.parsed_output;
    lastProblems = validateShape(spec);
    if (!lastProblems.length) return { spec, model, attempts: attempt };
  }

  throw new Error(`Generated spec still invalid after 2 attempts: ${lastProblems.join('; ')}`);
}
