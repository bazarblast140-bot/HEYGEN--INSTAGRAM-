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
    duration: data?.duration,
    error: data?.error || null,
  };
}

/**
 * Text to speech. Far cheaper than avatar video, so it carries every second of a
 * reel the avatar is not on screen. Returns word-level timestamps, which is what
 * lets captions be cut to the word without a separate alignment pass.
 *
 * NOTE: the REST path could not be verified against HeyGen's docs (docs.heygen.com
 * is unreachable from the build environment). `/v3/speech` is the best inference
 * from the surrounding v3 voice endpoints. If it 404s, set HEYGEN_SPEECH_PATH to
 * the correct path rather than editing this file — the error below says so too.
 */
const SPEECH_PATH = process.env.HEYGEN_SPEECH_PATH || '/v3/speech';

export async function createSpeech({ text, voiceId, speed = 1, locale, inputType = 'text' }) {
  if (!text?.trim()) throw new Error('createSpeech needs text');
  if (!voiceId) throw new Error('createSpeech needs a voiceId');

  let payload;
  try {
    payload = await request(SPEECH_PATH, {
      method: 'POST',
      body: { text: text.trim(), voice_id: voiceId, speed, input_type: inputType, ...(locale ? { locale } : {}) },
    });
  } catch (err) {
    if (err.status === 404) {
      throw new Error(
        `HeyGen TTS endpoint ${SPEECH_PATH} returned 404. The path is unverified — ` +
        'check the current docs and set HEYGEN_SPEECH_PATH to the right one.',
      );
    }
    throw err;
  }

  const data = payload?.data || payload;
  if (!data?.audio_url) throw new Error('HeyGen TTS returned no audio_url');

  return {
    audioUrl: data.audio_url,
    duration: data.duration,
    wordTimestamps: data.word_timestamps || [],
  };
}

export async function getQuota() {
  const { data } = await request('/v2/user/remaining_quota');
  return data;
}

export { request as heygenRequest, UPLOAD_URL };
