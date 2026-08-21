// Where the reel's voice comes from.
//
// It was HeyGen, and only HeyGen, which turned out to be a single point of
// failure with a price attached: /v1/tts.generate answers 403 to an API key on
// the free plan, so the automation could not speak at all even though the same
// account synthesises the same cloned voice perfectly well from the web app.
//
// One vendor holding the voice hostage is a design problem, not just a billing
// one. So the voice is a provider now, chosen by which key is present, and the
// pipeline does not care which one answered. The shape every provider returns:
//
//   { audio: Buffer, format: 'wav'|'mp3', duration: number|null, words: [{word,start,end}] }
//
// Word timings are the part that matters downstream — they are what put a beat
// boundary in a pause instead of in the middle of a word.

import { createSpeech } from '../../../src/heygen.js';
import { env } from '../../../src/config.js';

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetching synthesised audio failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** HeyGen: the cloned voice that already exists, when the plan allows the API. */
const heygen = {
  name: 'heygen',
  configured: () => Boolean(env('HEYGEN_API_KEY')),
  async synth({ text, speed, voiceId, language }) {
    const speech = await createSpeech({
      text,
      voiceId: voiceId || env('HEYGEN_VOICE_ID'),
      speed,
      language: language || 'hi',
    });
    return {
      audio: await fetchBuffer(speech.audioUrl),
      format: 'wav',
      duration: speech.duration ?? null,
      words: speech.wordTimestamps || [],
    };
  },
};

/**
 * ElevenLabs returns alignment per CHARACTER, not per word. Rebuilding words
 * from it is the whole job: walk the characters, and every time whitespace ends
 * a run, close the word at the last non-space character's end time.
 *
 * Done carefully because the naive version — split the text on spaces and index
 * into the arrays — drifts the moment the model emits a character the input did
 * not contain, which multilingual models do for punctuation and numerals.
 */
export function wordsFromCharacterAlignment(alignment) {
  const chars = alignment?.characters || [];
  const starts = alignment?.character_start_times_seconds || [];
  const ends = alignment?.character_end_times_seconds || [];
  if (!chars.length || chars.length !== starts.length || chars.length !== ends.length) return [];

  const words = [];
  let current = null;

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (/\s/.test(ch)) {
      if (current) { words.push(current); current = null; }
      continue;
    }
    if (!current) current = { word: ch, start: starts[i], end: ends[i] };
    else { current.word += ch; current.end = ends[i]; }
  }
  if (current) words.push(current);

  return words;
}

const ELEVEN = 'https://api.elevenlabs.io/v1';

function elevenHeaders(extra = {}) {
  return { 'xi-api-key': env('ELEVENLABS_API_KEY'), Accept: 'application/json', ...extra };
}

/**
 * Find the cloned voice on the account, so nobody has to copy an id by hand.
 *
 * ELEVENLABS_VOICE_ID still wins when set. Without it, the account is asked:
 * a voice the user cloned or had professionally cloned is what we want, and
 * ElevenLabs marks those with a category. The stock "premade" voices are
 * explicitly not what this reel is for — the whole complaint that started this
 * was that a generic voice ruins it — so they are chosen only as a last resort,
 * and the caller is told when that happens.
 */
let discoveredVoice = null;

export async function discoverElevenVoice() {
  const configured = env('ELEVENLABS_VOICE_ID');
  if (configured) return { id: configured, name: null, category: 'configured' };
  if (discoveredVoice) return discoveredVoice;

  const res = await fetch(`${ELEVEN}/voices`, { headers: elevenHeaders() });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw Object.assign(new Error(`ElevenLabs /voices returned ${res.status}: ${detail}`), { status: res.status });
  }

  const voices = (await res.json())?.voices || [];
  if (!voices.length) throw new Error('The ElevenLabs account has no voices at all.');

  const byCategory = (want) => voices.find((v) => String(v.category || '').toLowerCase() === want);
  const cloned = byCategory('professional') || byCategory('cloned') || byCategory('generated');

  if (!cloned) {
    throw Object.assign(new Error(
      `No cloned voice on the ElevenLabs account — found only ${voices.map((v) => v.category).join(', ')}. ` +
      'Clone Rajesh\'s voice at elevenlabs.io (Voices -> Add voice -> Instant voice clone) ' +
      'and it will be picked up automatically, or set ELEVENLABS_VOICE_ID.',
    ), { noClonedVoice: true });
  }

  discoveredVoice = { id: cloned.voice_id, name: cloned.name, category: cloned.category };
  return discoveredVoice;
}

const elevenlabs = {
  name: 'elevenlabs',
  configured: () => Boolean(env('ELEVENLABS_API_KEY')),
  async synth({ text, speed, voiceId }) {
    const voice = voiceId || (await discoverElevenVoice()).id;
    const model = env('ELEVENLABS_MODEL') || 'eleven_multilingual_v2';

    // The with-timestamps variant costs the same and returns the alignment that
    // the plain endpoint throws away.
    const res = await fetch(
      `${ELEVEN}/text-to-speech/${encodeURIComponent(voice)}/with-timestamps`,
      {
        method: 'POST',
        headers: elevenHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          text,
          model_id: model,
          // Hinglish is Hindi script-switched into Latin letters; the multilingual
          // model handles it, but only if it is not told the text is English.
          voice_settings: { stability: 0.45, similarity_boost: 0.85, speed },
        }),
      },
    );

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw Object.assign(new Error(`ElevenLabs returned ${res.status}: ${detail}`), { status: res.status });
    }

    const body = await res.json();
    if (!body?.audio_base64) throw new Error('ElevenLabs returned no audio');

    const words = wordsFromCharacterAlignment(body.alignment || body.normalized_alignment);
    return {
      audio: Buffer.from(body.audio_base64, 'base64'),
      format: 'mp3',
      duration: words.length ? words[words.length - 1].end : null,
      words,
    };
  },
};

export const VOICE_PROVIDERS = [heygen, elevenlabs];

/**
 * Pick a provider. An explicit VOICE_PROVIDER wins; otherwise the first one
 * that is configured. HeyGen leads because it already holds the cloned voice.
 */
export function resolveVoiceProvider(preferred = env('VOICE_PROVIDER')) {
  if (preferred) {
    const chosen = VOICE_PROVIDERS.find((p) => p.name === preferred);
    if (!chosen) throw new Error(`Unknown VOICE_PROVIDER "${preferred}". Known: ${VOICE_PROVIDERS.map((p) => p.name).join(', ')}`);
    return chosen;
  }
  return VOICE_PROVIDERS.find((p) => p.configured()) || null;
}

/**
 * Synthesise, and fall through to the next configured provider if one refuses
 * for a reason that another provider would not hit — an entitlement or quota
 * wall. A malformed request would fail everywhere, so that still throws.
 */
export async function synthesise(options) {
  const preferred = env('VOICE_PROVIDER');
  const chain = preferred
    ? [resolveVoiceProvider(preferred)]
    : VOICE_PROVIDERS.filter((p) => p.configured());

  if (!chain.length) {
    throw new Error(
      'No voice provider configured. Set HEYGEN_API_KEY (needs a plan entitled to ' +
      '/v1/tts.generate), or ELEVENLABS_API_KEY.',
    );
  }

  const refusals = [];
  for (const provider of chain) {
    try {
      const result = await provider.synth(options);
      return { ...result, provider: provider.name };
    } catch (err) {
      const wall = err.entitlement || [401, 402, 403, 429].includes(err.status);
      refusals.push(`${provider.name}: ${err.message.slice(0, 120)}`);
      if (!wall || provider === chain[chain.length - 1]) {
        if (chain.length === 1) throw err;
        throw new Error(`Every voice provider refused — ${refusals.join(' | ')}`);
      }
    }
  }

  throw new Error(`Every voice provider refused — ${refusals.join(' | ')}`);
}
