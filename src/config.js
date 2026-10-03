import 'dotenv/config';

/**
 * Read an environment value with surrounding whitespace removed.
 *
 * Not defensive padding: a GitHub repository variable pasted with a trailing
 * newline sent HeyGen an avatar id ending in \r\n, and HeyGen answered "avatar
 * look not found" — an error that points at the id rather than at the invisible
 * character after it. Every id, key and token now goes through here.
 */
export function env(name, fallback = '') {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : fallback;
}

/**
 * The presenter, verified against the live HeyGen account rather than typed from
 * memory. These are defaults in code, not repository variables, for a reason: the
 * ids are not secret, they change about once a year, and every time they lived in
 * a GitHub variable somebody pasted one with a trailing newline and the morning's
 * reel lost its face to an error message that blamed the id.
 *
 * Environment values still win, so a new clone needs no code change.
 *
 *   avatar  "Rajesh Video 1"  digital_twin, 720x1280 portrait
 *           supports avatar_v / avatar_iv / avatar_iii
 *
 * avatar_iii is the default because the API bills per second of output and the
 * three engines are not priced alike: for a digital twin at 1080p it is about
 * $1.00 a minute against roughly $4.00 for avatar_iv and avatar_v. The reel
 * needs the face for about seven seconds -- the hook and the cut-in, with
 * ElevenLabs carrying the rest -- so the choice is about 13 cents a reel
 * against about 50. Same clone, same lip-sync path; four times the runway.
 *   voice   the twin's own cloned voice (Hindi, male)
 */
export const PRESENTER = {
  avatarId: '43ea820171e04d0eb3c4e457124c3828',
  avatarKind: 'avatar',
  engine: 'avatar_iii',
  voiceId: 'ad3099687f824940811e3fb3ec3e3beb',
};

/**
 * The one voice the Instagram Reel is allowed to speak in: "Rudra", a voice from
 * the ElevenLabs library (energetic Hindi finance narration, the same voice and
 * settings the Paise Ki Pathshala channel uses).
 *
 * Owner's decision, 3 Oct 2026: the reel no longer uses Rajesh's own cloned
 * voice. The synthesiser refuses any other voice id before a single ElevenLabs
 * credit is spent, and the build workflow checks the voice on the account
 * before the build starts. Override only with the REEL_VOICE_ID repository
 * variable, deliberately, together with ELEVENLABS_VOICE_ID.
 */
export const REEL_VOICE_ID = 'ypnkIsDASPgHZuanrF0q';
export const REEL_VOICE_NAME = 'Rudra';

/**
 * ElevenLabs synthesis defaults for the reel.
 *
 * A voice id is not a credential — it names a voice on the account and is
 * useless without the API key — so it lives here for the same reason the HeyGen
 * ids do: a repository variable is one more place for a stray newline to hide,
 * and that has already cost this project a morning.
 *
 * Repository variables override: ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL,
 * ELEVENLABS_STABILITY, ELEVENLABS_STYLE, ELEVENLABS_SPEED.
 *
 * `speed` is the base pace. Callers pass a relative factor (1 = as is); the
 * request carries speed x factor, clamped to ElevenLabs' allowed 0.7–1.2.
 */
export const ELEVEN = {
  voiceId: REEL_VOICE_ID,
  voiceName: REEL_VOICE_NAME,
  model: 'eleven_multilingual_v2',
  stability: 0.5,
  similarityBoost: 0.85,
  style: 0.25,
  speed: 0.9,
  useSpeakerBoost: true,
};

/** ElevenLabs rejects voice_settings.speed outside this range. */
export const ELEVEN_SPEED_RANGE = { min: 0.7, max: 1.2 };

export const config = {
  apiKey: env('HEYGEN_API_KEY'),
  port: Number(env('PORT')) || 3000,
  defaultAvatarId: env('DEFAULT_AVATAR_ID') || PRESENTER.avatarId,
  defaultVoiceId: env('DEFAULT_VOICE_ID') || PRESENTER.voiceId,
};

// Instagram-friendly output sizes. Reels/Stories are 9:16, feed posts are 1:1.
export const PRESETS = {
  reel: { label: 'Reel / Story (9:16)', width: 720, height: 1280 },
  feed: { label: 'Feed post (1:1)', width: 1080, height: 1080 },
  landscape: { label: 'Landscape (16:9)', width: 1280, height: 720 },
};

// Instagram caps Reels at 90 seconds. Roughly 150 spoken words per minute,
// so we keep scripts under ~220 words to stay inside that budget.
export const MAX_SCRIPT_WORDS = 220;

export function assertApiKey() {
  if (!config.apiKey) {
    throw Object.assign(new Error('HEYGEN_API_KEY is not set. Copy .env.example to .env and add your key.'), {
      status: 500,
    });
  }
}
