// Presenter panel: script -> HeyGen avatar clip on disk.
//
// Reuses the repo's HeyGen client so there is one place that knows the API shape.
// The avatar and voice are configuration, not code — set HEYGEN_AVATAR_ID and
// HEYGEN_VOICE_ID in .env, or pass them per call.

import fs from 'node:fs/promises';
import path from 'node:path';
import { generateVideo, getVideoStatus, listAvatars } from '../../../src/heygen.js';
import { config } from '../../../src/config.js';

// The bottom half of a 1080x1920 hybrid frame.
export const PANEL = { width: 1080, height: 780 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HeyGen takes `avatar_id` for studio avatars and `talking_photo_id` for photo
 * avatars, and rejects the wrong one with a bare "not found". Rather than making
 * that a config field somebody gets wrong six months from now, look the id up and
 * decide from what the account actually holds.
 */
export async function resolveCharacterKind(id) {
  const { avatars, talkingPhotos } = await listAvatars();
  if (avatars.some((a) => a.id === id)) return 'avatar';
  if (talkingPhotos.some((p) => p.id === id)) return 'talking_photo';
  throw new Error(`No avatar or talking photo in this HeyGen account has id ${id}`);
}

export async function renderPresenter({
  script,
  avatarId = process.env.HEYGEN_AVATAR_ID || config.defaultAvatarId,
  voiceId = process.env.HEYGEN_VOICE_ID || config.defaultVoiceId,
  characterKind,
  speed = 1,
  width = PANEL.width,
  height = PANEL.height,
  background = { type: 'color', value: '#020617' },
  out,
  pollMs = 5000,
  maxPolls = 180,
  onStatus,
}) {
  if (!script?.trim()) throw new Error('renderPresenter needs a script');
  if (!avatarId) throw new Error('No avatar id. Set HEYGEN_AVATAR_ID in .env or pass avatarId.');
  if (!voiceId) throw new Error('No voice id. Set HEYGEN_VOICE_ID in .env or pass voiceId.');

  const kind = characterKind || (await resolveCharacterKind(avatarId));

  const { videoId } = await generateVideo({
    script: script.trim(),
    avatarId,
    voiceId,
    characterKind: kind,
    speed,
    width,
    height,
    background,
    // Captions are burned in downstream by the caption engine, so that both
    // caption layers share one style instead of HeyGen owning half of them.
    captionsBurnedIn: false,
  });

  onStatus?.({ videoId, status: 'submitted', characterKind: kind });

  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(pollMs);
    const status = await getVideoStatus(videoId);
    onStatus?.(status);

    if (status.status === 'failed') {
      throw new Error(`HeyGen render failed: ${status.error?.message || 'no reason given'}`);
    }
    if (status.status === 'completed') {
      const file = out || path.join(process.cwd(), `${videoId}.mp4`);
      await fs.mkdir(path.dirname(file), { recursive: true });

      const res = await fetch(status.videoUrl);
      if (!res.ok) throw new Error(`Downloading the finished clip failed (${res.status})`);
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));

      return { videoId, file, duration: status.duration, url: status.videoUrl };
    }
  }

  throw new Error(
    `HeyGen still rendering after ${Math.round((pollMs * maxPolls) / 1000)}s (video ${videoId}). ` +
    'Check the HeyGen dashboard.',
  );
}
