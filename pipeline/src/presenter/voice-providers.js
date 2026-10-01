// The reel's voice is ElevenLabs. HeyGen is not on this path.
//
// Every provider returns:
//   { audio: Buffer, format: 'wav'|'mp3', duration: number|null, words: [{word,start,end}] }
//
// Word timings put a beat boundary in a pause instead of in the middle of a word.

import { env, ELEVEN as ELEVEN_DEFAULTS } from '../../../src/config.js';

function publicError(detail) {
  const clean = String(detail || 'no detail')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/xi-api-key['":\s]+[\w.-]+/gi, 'xi-api-key [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return clean;
}

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

/**
 * Voice and model used for synthesis.
 * Repository variables ELEVENLABS_VOICE_ID and ELEVENLABS_MODEL override these.
 * A blank variable (the repo var is unset) keeps the built-in defaults.
 */
export function elevenSettings() {
  return {
    voiceId: env('ELEVENLABS_VOICE_ID') || ELEVEN_DEFAULTS.voiceId,
    model: env('ELEVENLABS_MODEL') || ELEVEN_DEFAULTS.model,
  };
}

export async function discoverElevenVoice() {
  const configured = elevenSettings().voiceId;
  if (configured) return { id: configured, name: null, category: 'configured' };
  if (discoveredVoice) return discoveredVoice;

  const res = await fetch(`${ELEVEN}/voices`, { headers: elevenHeaders() });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // A restricted key is the common case and looks exactly like a wrong key
    // from the outside. Say which switch to flip rather than "unauthorized".
    if (/missing_permissions|permission/i.test(detail)) {
      throw Object.assign(new Error(
        'The ElevenLabs key is valid but restricted: it lacks the "voices_read" permission. ' +
        'Either enable Voices > Read on the key, or set ELEVENLABS_VOICE_ID so the voice ' +
        'never has to be looked up. Synthesis additionally needs "text_to_speech".',
      ), { status: res.status, permissions: true });
    }
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
    const settings = elevenSettings();
    const voice = voiceId || settings.voiceId || (await discoverElevenVoice()).id;
    const model = settings.model;

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
      const detail = publicError(await res.text());
      let kind = 'request';
      if (res.status === 401 || res.status === 403) kind = 'auth';
      else if (res.status === 402 || res.status === 429) kind = 'balance';
      if (/missing_permissions|permission/i.test(detail)) {
        throw Object.assign(new Error(
          `ElevenLabs HTTP ${res.status}: auth problem — the key lacks the "text_to_speech" permission.`,
        ), { status: res.status, permissions: true, kind });
      }
      const label = kind === 'auth' ? 'auth problem' : kind === 'balance' ? 'balance or rate-limit problem' : 'request problem';
      throw Object.assign(
        new Error(`ElevenLabs HTTP ${res.status}: ${label} — ${detail}`),
        { status: res.status, kind },
      );
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

export const VOICE_PROVIDERS = [elevenlabs];

/**
 * ElevenLabs is the reel voice. HeyGen is not a provider here, even when its
 * key is present.
 */
export function resolveVoiceProvider(preferred = env('VOICE_PROVIDER')) {
  if (preferred && preferred !== 'elevenlabs') {
    throw new Error(
      `VOICE_PROVIDER "${preferred}" is not used for reels. Leave it unset or set ELEVENLABS. ` +
      'The voice is ElevenLabs.',
    );
  }
  const chosen = VOICE_PROVIDERS.find((p) => p.configured());
  if (!chosen) {
    throw new Error('ELEVENLABS_API_KEY is not set. Reels do not use HeyGen for voice.');
  }
  return chosen;
}

/** Synthesise with ElevenLabs. A failure is returned to the caller; nothing else speaks. */
export async function synthesise(options) {
  const provider = resolveVoiceProvider();
  const result = await provider.synth(options);
  return { ...result, provider: provider.name };
}
