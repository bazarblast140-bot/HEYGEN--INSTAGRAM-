// Spoken length for a reel that must finish between 20 and 30 seconds.
// At about 2.8 words a second, 56 words is 20s and 78 words is about 28s.

export const SPOKEN_MIN_WORDS = 56;
export const SPOKEN_MAX_WORDS = 78;
export const SPOKEN_TARGET_WORDS = 64;

export const WORD_BUDGET = {
  hook: 12,
  body: 40,
  cta: 12,
};

export function wordsIn(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

export function spokenWordCount(spec) {
  return (spec?.segments || []).reduce((n, beat) => n + wordsIn(beat?.say), 0);
}

/**
 * The line sent back on the next attempt. Over-long scripts are told the
 * exact count and the number of words to cut to. Short scripts are not told
 * to pad.
 */
export function wordCountProblem(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || (n >= SPOKEN_MIN_WORDS && n <= SPOKEN_MAX_WORDS)) return null;
  if (n > SPOKEN_MAX_WORDS) {
    return `your script had ${n} words; it must be ${SPOKEN_MIN_WORDS}–${SPOKEN_MAX_WORDS} words total; cut to ${SPOKEN_TARGET_WORDS} words`;
  }
  return `your script had ${n} words; it must be ${SPOKEN_MIN_WORDS}–${SPOKEN_MAX_WORDS} words total; do not add filler`;
}

export function retryNoteFor(problems) {
  const lines = (problems || []).map((problem) => {
    const count = String(problem).match(/^(\d+) spoken words/);
    if (count) return wordCountProblem(Number(count[1])) || problem;
    const already = String(problem).match(/your script had (\d+) words/);
    if (already) return wordCountProblem(Number(already[1])) || problem;
    return problem;
  });
  return [
    'Your previous attempt was rejected:',
    ...lines.map((line) => `- ${line}`),
    'Fix exactly these and return the full spec again.',
  ].join('\n');
}

function splitSentences(say) {
  const parts = String(say || '').trim().split(/(?<=[.?!।])\s+/).map((s) => s.trim()).filter(Boolean);
  return parts;
}

function isProtected(segments, index) {
  if (index === 0 || index === segments.length - 1) return true;
  return segments[index]?.type === 'hook';
}

function dropRank(type) {
  if (type === 'card') return 0;
  if (type === 'article') return 1;
  if (type === 'cutin') return 2;
  if (type === 'stock') return 3;
  if (type === 'chart') return 4;
  return 2;
}

function canDrop(segments, index) {
  if (isProtected(segments, index)) return false;
  const type = segments[index]?.type;
  if (type === 'chart' && segments.filter((s) => s.type === 'chart').length <= 1) return false;
  if (type === 'stock' && segments.filter((s) => s.type === 'stock').length <= 1) return false;
  return true;
}

function withBody(spec) {
  return {
    ...spec,
    body: spec.segments.map((s) => String(s.say || '').trim()).filter(Boolean).join(' '),
  };
}

function cloneSpec(spec) {
  return {
    ...spec,
    segments: (spec.segments || []).map((beat) => ({
      ...beat,
      card: beat.card && typeof beat.card === 'object' ? { ...beat.card } : beat.card,
    })),
  };
}

/**
 * Pull a too-long script down into 56–78 words.
 * Hook and the final CTA stay word for word. Body cuts happen on sentence
 * boundaries, then by dropping the least important body beat. Nothing is
 * added when the script is already short.
 */
export function shortenReelScript(spec, { min = SPOKEN_MIN_WORDS, max = SPOKEN_MAX_WORDS } = {}) {
  const next = cloneSpec(spec || { segments: [] });
  if (spokenWordCount(next) <= max) return withBody(next);

  let guard = 0;
  while (spokenWordCount(next) > max && guard < 200) {
    guard += 1;
    const trimmed = trimOneSentence(next, min);
    if (trimmed) {
      next.segments = trimmed;
      continue;
    }
    const dropped = dropOneSegment(next, min);
    if (dropped) {
      next.segments = dropped;
      continue;
    }
    break;
  }
  return withBody(next);
}

function trimOneSentence(spec, min) {
  const segments = spec.segments;
  const total = spokenWordCount(spec);
  const candidates = segments
    .map((beat, index) => ({ beat, index, sentences: splitSentences(beat.say) }))
    .filter(({ index, sentences }) => !isProtected(segments, index) && sentences.length > 1)
    .sort((a, b) => dropRank(a.beat.type) - dropRank(b.beat.type) || b.index - a.index);

  for (const candidate of candidates) {
    const removed = candidate.sentences[candidate.sentences.length - 1];
    const after = total - wordsIn(removed);
    if (after < min) continue;
    const say = candidate.sentences.slice(0, -1).join(' ');
    return segments.map((beat, index) => (index === candidate.index ? { ...beat, say } : beat));
  }
  return null;
}

function dropOneSegment(spec, min) {
  const segments = spec.segments;
  const total = spokenWordCount(spec);
  const candidates = segments
    .map((beat, index) => ({ beat, index }))
    .filter(({ index }) => canDrop(segments, index))
    .sort((a, b) => dropRank(a.beat.type) - dropRank(b.beat.type) || b.index - a.index);

  for (const candidate of candidates) {
    const after = total - wordsIn(candidate.beat.say);
    if (after < min) continue;
    return segments.filter((_, index) => index !== candidate.index);
  }
  return null;
}
