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
import { readHistory, findRepeat, recordTopic } from './topics.js';

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
  type: z.enum(['hook', 'cutin', 'chart', 'card', 'stock']),
  seconds: z.number().nullable(),
  say: z.string(),
  caption: z.string(),
  power: z.string(),
  card: Card.nullable(),
  // Only a "stock" beat uses this: the search phrase sent to Pexels. Every other
  // beat leaves it null. The card stays optional on a stock beat too, because it
  // is what gets rendered if the footage search comes back empty.
  query: z.string().nullable(),
});

const ReelSpec = z.object({
  topic: z.string(),
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
function validateShape(spec, recentTopics = []) {
  const problems = [];

  // The prompt asks for a new subject; this is what makes it a rule. A model
  // that has been handed similar numbers five days running will otherwise find
  // the same story in them five times.
  const repeat = findRepeat(spec.topic, recentTopics);
  if (repeat) {
    problems.push(
      `topic "${spec.topic}" repeats ${repeat.date}'s reel ("${repeat.topic}") — pick a different subject entirely`,
    );
  }
  // Runtime is set by how long the narration actually takes, so the check is on
  // the words rather than on numbers the model guessed.
  const words = spec.segments.reduce((n, s) => n + String(s.say || '').trim().split(/\s+/).filter(Boolean).length, 0);

  if (words < 55 || words > 115) problems.push(`${words} spoken words is outside 55–115 (about 22–40 seconds)`);
  if (!spec.segments.some((s) => s.type === 'hook')) problems.push('no hook beat');
  if (!spec.segments.some((s) => s.type === 'chart')) problems.push('no chart beat');

  // Two ways a card prints the same thing twice, both seen in a finished reel.
  for (const [i, beat] of spec.segments.entries()) {
    const power = String(beat.card?.power || '').trim().toLowerCase();
    const stat = String(beat.card?.stat?.value || '').trim().toLowerCase();
    if (power && power === stat) {
      problems.push(`beat ${i}: card.power and card.stat.value are both "${beat.card.power}"`);
    }
    const next = spec.segments[i + 1]?.card;
    if (beat.type === 'cutin' && beat.card && next
      && String(beat.card.headline || '').trim().toLowerCase()
         === String(next.headline || '').trim().toLowerCase()) {
      problems.push(`beat ${i}: the cut-in repeats the next beat's headline "${next.headline}"`);
    }
  }

  // Footage is what stops the reel being eight dark cards in a row, but a reel
  // that is mostly footage stops being about the numbers. One or two beats.
  const stock = spec.segments.filter((s) => s.type === 'stock');
  if (!stock.length) problems.push('no stock beat — at least one beat must be real footage, not a card');
  if (stock.length > 2) problems.push(`${stock.length} stock beats is too many; use one or two`);
  for (const beat of stock) {
    if (!beat.query?.trim()) problems.push('a stock beat has no "query" to search footage with');
    else if (beat.query.trim().split(/\s+/).length > 4) {
      // Pexels matches on plain visual nouns. "Indian retail investors reacting
      // to a mutual fund inflow record" returns nothing; "stock market screen"
      // returns a hundred usable clips.
      problems.push(`stock query "${beat.query}" is too specific — use 2 to 4 plain visual words`);
    }
  }

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

  const recentTopics = await readHistory();

  let lastProblems = [];
  // Three attempts rather than two: a rejected topic costs a pass on its own,
  // and it would be a shame to spend the retry budget on that and have none
  // left for a genuine schema slip.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let userPrompt = buildUserPrompt({ market, news, date, recentTopics });

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

      lastProblems = validateShape(output, recentTopics);
      if (!lastProblems.length) {
        // Written down only once the spec is accepted, so a rejected draft does
        // not burn a subject the reel never actually covered.
        await recordTopic({ topic: output.topic, angle: output.verdict, date });
        return { spec: output, provider: provider.name, model: used, attempts: attempt };
      }
    } catch (err) {
      // A schema mismatch is worth one more pass with the field paths attached;
      // an auth or model-name failure is not going to fix itself.
      if (!err.schemaIssues || attempt === 3) throw err;
      lastProblems = err.schemaIssues;
    }
  }

  throw new Error(`Generated spec still invalid after 3 attempts: ${lastProblems.join('; ')}`);
}
