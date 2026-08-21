import { config, assertApiKey } from './config.js';

const BASE_URL = 'https://api.heygen.com';
const UPLOAD_URL = 'https://upload.heygen.com';

async function request(path, { method = 'GET', body, baseUrl = BASE_URL } = {}) {
  assertApiKey();

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'X-Api-Key': config.apiKey,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  // HeyGen returns HTTP 200 with an `error` object on some failures, so check both.
  const apiError = payload?.error;
  if (!res.ok || apiError) {
    const message = apiError?.message || payload?.message || `HeyGen request failed (${res.status})`;
    throw Object.assign(new Error(message), { status: res.ok ? 502 : res.status, details: payload });
  }

  return payload;
}

export async function listAvatars() {
  const { data } = await request('/v2/avatars');
  return {
    avatars: (data?.avatars || []).map((a) => ({
      id: a.avatar_id,
      name: a.avatar_name,
      gender: a.gender,
      preview: a.preview_image_url,
      kind: 'avatar',
    })),
    talkingPhotos: (data?.talking_photos || []).map((p) => ({
      id: p.talking_photo_id,
      name: p.talking_photo_name,
      preview: p.preview_image_url,
      kind: 'talking_photo',
    })),
  };
}

/**
 * Find an avatar look by id, including looks that live inside avatar groups.
 *
 * This exists because /v2/avatars does not list them. Rajesh's video clone is a
 * `digital_twin` inside the group "Rajesh Video 1", so the flat listing reports
 * a perfectly valid id as "not found" — which is what made the presenter beat
 * silently disappear from earlier reels.
 *
 * Returns null rather than throwing: this informs a decision, it does not gate one.
 */
export async function findAvatarLook(lookId) {
  try {
    const { data } = await request('/v2/avatar_group.list');
    const groups = data?.avatar_group_list || data?.avatar_groups || [];

    for (const group of groups) {
      const groupId = group.id || group.group_id;
      if (!groupId) continue;

      const { data: looks } = await request(`/v2/avatar_group/${encodeURIComponent(groupId)}/avatars`);
      const found = (looks?.avatar_list || looks?.avatars || []).find(
        (a) => (a.id || a.avatar_id) === lookId,
      );
      if (found) {
        return {
          id: lookId,
          groupId,
          type: found.avatar_type || found.type || null,
          defaultVoiceId: found.default_voice_id || group.default_voice_id || null,
          engines: found.supported_api_engines || [],
        };
      }
    }
  } catch {
    // A listing failure must not decide whether the presenter appears.
  }
  return null;
}

export async function listVoices() {
  const { data } = await request('/v2/voices');
  return (data?.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    language: v.language,
    gender: v.gender,
    preview: v.preview_audio,
    supportsPause: v.support_pause,
    emotionSupport: v.emotion_support,
  }));
}

function buildCharacter({ avatarId, characterKind = 'avatar', avatarStyle = 'normal' }) {
  if (characterKind === 'talking_photo') {
    return { type: 'talking_photo', talking_photo_id: avatarId };
  }
  return { type: 'avatar', avatar_id: avatarId, avatar_style: avatarStyle };
}

export async function generateVideo({
  script,
  avatarId,
  voiceId,
  characterKind = 'avatar',
  avatarStyle = 'normal',
  engine,
  speed = 1,
  width = 720,
  height = 1280,
  title,
  captionsBurnedIn = false,
  background,
}) {
  const payload = {
    video_inputs: [
      {
        character: buildCharacter({ avatarId, characterKind, avatarStyle }),
        voice: { type: 'text', input_text: script, voice_id: voiceId, speed },
        ...(background ? { background } : {}),
      },
    ],
    dimension: { width, height },
    caption: Boolean(captionsBurnedIn),
    // A digital twin supports higher-quality engines than a photo avatar; which
    // ones is a property of the look, so it is passed in rather than assumed.
    ...(engine ? { engine: { type: engine } } : {}),
    ...(title ? { title } : {}),
  };

  const { data } = await request('/v2/video/generate', { method: 'POST', body: payload });
  return { videoId: data?.video_id };
}

export async function getVideoStatus(videoId) {
  const { data } = await request(`/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`);
  return {
    videoId,
    status: data?.status,
    videoUrl: data?.video_url,
    thumbnailUrl: data?.thumbnail_url,
    captionUrl: data?.caption_url,
    subtitleUrl: data?.subtitle_url,
    duration: data?.duration,
    error: data?.error || null,
    // Both spellings appear depending on which API family answered.
    errorCode: data?.error?.code || data?.failure_code || null,
    errorMessage: data?.error?.message || data?.failure_message || null,
  };
}

/**
 * Text to speech in Rajesh's own cloned voice.
 *
 * This is now the backbone of the reel, not a side feature. Avatar video is
 * metered — the account's monthly avatar allowance runs out and every engine
 * then refuses — but speech synthesis keeps working, so the voice survives a
 * quota wall that the face does not.
 *
 * Returns word-level timestamps, which is what lets captions land on the word
 * and beats land on the sentence without a separate alignment pass.
 *
 * The REST path is probed rather than assumed: an earlier guess at /v3/speech
 * came back 404 in production, and this container cannot reach api.heygen.com
 * to settle it. Whichever candidate answers is remembered for the rest of the
 * run and logged, so it can be pinned with HEYGEN_SPEECH_PATH afterwards.
 */
const SPEECH_PATHS = process.env.HEYGEN_SPEECH_PATH
  ? [process.env.HEYGEN_SPEECH_PATH.trim()]
  : [
      '/v3/speech',
      '/v2/speech',
      '/v1/speech',
      '/v3/text_to_speech',
      '/v2/text_to_speech',
      '/v3/tts',
      '/v2/audio/generate',
      '/v1/audio/generate',
    ];

let resolvedSpeechPath = null;

export async function createSpeech({ text, voiceId, speed = 1, locale, language, inputType = 'text' }) {
  if (!text?.trim()) throw new Error('createSpeech needs text');
  if (!voiceId) throw new Error('createSpeech needs a voiceId');

  const body = {
    text: text.trim(),
    voice_id: voiceId,
    speed,
    input_type: inputType,
    ...(locale ? { locale } : {}),
    ...(language ? { language } : {}),
  };

  const candidates = resolvedSpeechPath ? [resolvedSpeechPath] : SPEECH_PATHS;

  let payload;
  const tried = [];

  for (const candidate of candidates) {
    try {
      payload = await request(candidate, { method: 'POST', body });
      if (resolvedSpeechPath !== candidate) {
        resolvedSpeechPath = candidate;
        console.log(`HeyGen TTS endpoint resolved to ${candidate} — pin it with HEYGEN_SPEECH_PATH to skip probing.`);
      }
      break;
    } catch (err) {
      // Only a missing endpoint justifies trying the next candidate. Any other
      // status means the endpoint exists and rejected the request, which must
      // surface rather than be masked by further probing.
      if (err.status !== 404) throw err;
      tried.push(candidate);
    }
  }

  if (!payload) {
    throw new Error(
      `No HeyGen TTS endpoint answered — all returned 404. Tried: ${tried.join(', ')}. ` +
      'Find the correct path in the current docs and set HEYGEN_SPEECH_PATH.',
    );
  }

  // The v3 shape returns these at the top level; older shapes nest them in data.
  const data = payload?.data || payload;
  if (!data?.audio_url) throw new Error('HeyGen TTS returned no audio_url');

  return {
    audioUrl: data.audio_url,
    duration: data.duration,
    // <start> and <end> markers are bookkeeping, not words.
    wordTimestamps: (data.word_timestamps || []).filter((w) => !/^<.*>$/.test(w.word || '')),
  };
}

/**
 * Did HeyGen refuse because the account is out of allowance, rather than because
 * the request was wrong?
 *
 * This matters because the two deserve opposite handling. A malformed request is
 * a bug to fix; an exhausted quota is a fact about the plan, and the reel should
 * carry on without the face rather than fail the morning's post. Observed codes:
 *
 *   MOVIO_PAYMENT_INSUFFICIENT_CREDIT                 (avatar_iii, needs a paid plan)
 *   AVATAR_IV_VIDEO_GENERATION_DURATION_LIMIT_REACHED (avatar_iv and avatar_v, monthly cap)
 */
export function isQuotaRefusal(err) {
  const haystack = [
    err?.message,
    err?.errorCode,
    err?.details?.error?.code,
    err?.details?.failure_code,
    err?.code,
  ].filter(Boolean).join(' ').toUpperCase().replace(/[^A-Z0-9]+/g, '_');

  return /INSUFFICIENT_CREDIT|LIMIT_REACHED|MONTHLY_LIMIT|REACHED_YOUR|OUT_OF_CREDIT|NOT_ENOUGH_CREDIT|QUOTA|EXCEEDED/.test(haystack);
}

export async function getQuota() {
  const { data } = await request('/v2/user/remaining_quota');
  return data;
}

export { request as heygenRequest, UPLOAD_URL };
