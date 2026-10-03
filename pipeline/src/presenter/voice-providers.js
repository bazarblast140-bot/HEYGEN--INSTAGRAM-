// The reel's voice is ElevenLabs. HeyGen is not on this path.
//
// Every provider returns:
//   { audio: Buffer, format: 'wav'|'mp3', duration: number|null, words: [{word,start,end}] }
//
// Word timings put a beat boundary in a pause instead of in the middle of a word.

import {
  env, ELEVEN as ELEVEN_DEFAULTS, ELEVEN_SPEED_RANGE, REEL_VOICE_ID,
} from '../../../src/config.js';

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
 * A numeric voice setting from a repository variable. Blank keeps the default;
 * anything else must be a number inside the range ElevenLabs accepts, or the
 * run stops here — a typo in a variable must not quietly change the voice.
 */
function numberSetting(name, fallback, min, max) {
  const raw = env(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw Object.assign(
      new Error(`${name}="${raw}" is not a number between ${min} and ${max}. Fix or clear the repository variable.`),
      { voiceConfig: true },
    );
  }
  return value;
}

/**
 * Voice, model and voice settings used for synthesis.
 * Repository variables ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL,
 * ELEVENLABS_STABILITY, ELEVENLABS_STYLE and ELEVENLABS_SPEED override these.
 * A blank variable (the repo var is unset) keeps the built-in defaults.
 *
 * `expectedVoiceId` is the only voice the reel may use (REEL_VOICE_ID in
 * src/config.js, overridable only by the REEL_VOICE_ID repository variable).
 */
export function elevenSettings() {
  return {
    voiceId: env('ELEVENLABS_VOICE_ID') || ELEVEN_DEFAULTS.voiceId,
    expectedVoiceId: env('REEL_VOICE_ID') || REEL_VOICE_ID,
    model: env('ELEVENLABS_MODEL') || ELEVEN_DEFAULTS.model,
    stability: numberSetting('ELEVENLABS_STABILITY', ELEVEN_DEFAULTS.stability, 0, 1),
    similarityBoost: ELEVEN_DEFAULTS.similarityBoost,
    style: numberSetting('ELEVENLABS_STYLE', ELEVEN_DEFAULTS.style, 0, 1),
    speed: numberSetting('ELEVENLABS_SPEED', ELEVEN_DEFAULTS.speed, ELEVEN_SPEED_RANGE.min, ELEVEN_SPEED_RANGE.max),
    useSpeakerBoost: ELEVEN_DEFAULTS.useSpeakerBoost,
  };
}

/**
 * The speed sent to ElevenLabs: the base pace times the caller's relative
 * factor (1 = as is), clamped to what the API accepts.
 */
export function effectiveSpeed(base, factor = 1) {
  const f = Number.isFinite(Number(factor)) && Number(factor) > 0 ? Number(factor) : 1;
  const raw = Number(base) * f;
  const clamped = Math.min(ELEVEN_SPEED_RANGE.max, Math.max(ELEVEN_SPEED_RANGE.min, raw));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * Hard stop if the voice about to be used is not the reel's voice. Runs before
 * any request, so a drifted variable or a stray voiceId costs nothing.
 * There is deliberately no "find a voice on the account" fallback: that path
 * once picked the owner's own clone, and must never pick anything again.
 */
export function assertReelVoice(voiceId, expected = elevenSettings().expectedVoiceId) {
  if (!voiceId || voiceId !== expected) {
    throw Object.assign(new Error(
      `Refusing to synthesise: the reel voice must be ${expected} (Rudra) but resolved to "${voiceId || '(none)'}". ` +
      'Check the ELEVENLABS_VOICE_ID repository variable. No ElevenLabs credit was spent.',
    ), { wrongVoice: true });
  }
  return voiceId;
}

/** The reel's voice, checked. No account lookup, no fallback. */
export function reelVoice() {
  const settings = elevenSettings();
  const id = assertReelVoice(settings.voiceId, settings.expectedVoiceId);
  return { id, name: ELEVEN_DEFAULTS.voiceName, category: 'configured' };
}

/** The voice_settings body for a synthesis call, for a relative speed factor. */
export function elevenVoiceSettings(settings, speedFactor = 1) {
  return {
    stability: settings.stability,
    similarity_boost: settings.similarityBoost,
    style: settings.style,
    use_speaker_boost: settings.useSpeakerBoost,
    speed: effectiveSpeed(settings.speed, speedFactor),
  };
}

const elevenlabs = {
  name: 'elevenlabs',
  configured: () => Boolean(env('ELEVENLABS_API_KEY')),
  async synth({ text, speed, voiceId }) {
    const settings = elevenSettings();
    // Guard first: a wrong voice stops here, before the request is built.
    const voice = assertReelVoice(voiceId || settings.voiceId, settings.expectedVoiceId);
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
          voice_settings: elevenVoiceSettings(settings, speed),
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

/**
 * Silent WAV sized from the script. Used for previews and tests so those
 * runs do not call ElevenLabs. A live publish does not set `local`.
 */
export function localSpeech({ text } = {}) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const slice = 0.35;
  let cursor = 0;
  const timed = (words.length ? words : [' ']).map((word) => {
    const start = cursor;
    cursor += slice;
    return { word, start, end: cursor };
  });
  const duration = Math.max(slice, cursor);
  const sampleRate = 8000;
  const samples = Math.max(1, Math.ceil(duration * sampleRate));
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return {
    audio: Buffer.concat([header, data]),
    format: 'wav',
    duration,
    words: timed,
    provider: 'local',
  };
}

export function wantsLocalVoice(options = {}, env = process.env) {
  return options.local === true || env.LOCAL_TTS === '1';
}

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

/** Synthesise with ElevenLabs. Previews and tests pass `local` and never call out. */
export async function synthesise(options = {}) {
  if (wantsLocalVoice(options)) return localSpeech(options);
  const provider = resolveVoiceProvider();
  const result = await provider.synth(options);
  return { ...result, provider: provider.name };
}
