import { Router } from 'express';
import { generateVideo, getVideoStatus, getQuota } from '../heygen.js';
import { config, PRESETS, MAX_SCRIPT_WORDS } from '../config.js';

const router = Router();

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

router.get('/presets', (req, res) => {
  res.json(PRESETS);
});

router.get('/quota', async (req, res, next) => {
  try {
    res.json(await getQuota());
  } catch (err) {
    next(err);
  }
});

router.post('/videos', async (req, res, next) => {
  try {
    const {
      script,
      avatarId = config.defaultAvatarId,
      voiceId = config.defaultVoiceId,
      characterKind,
      avatarStyle,
      speed,
      preset = 'reel',
      title,
      captions,
      backgroundColor,
    } = req.body || {};

    const text = String(script || '').trim();
    if (!text) throw badRequest('script is required');
    if (!avatarId) throw badRequest('avatarId is required (or set DEFAULT_AVATAR_ID in .env)');
    if (!voiceId) throw badRequest('voiceId is required (or set DEFAULT_VOICE_ID in .env)');

    const wordCount = text.split(/\s+/).length;
    if (wordCount > MAX_SCRIPT_WORDS) {
      throw badRequest(
        `script is ${wordCount} words; keep it under ${MAX_SCRIPT_WORDS} so the reel stays within Instagram's 90s limit`,
      );
    }

    const dimension = PRESETS[preset];
    if (!dimension) throw badRequest(`unknown preset "${preset}". Use one of: ${Object.keys(PRESETS).join(', ')}`);

    const result = await generateVideo({
      script: text,
      avatarId,
      voiceId,
      characterKind,
      avatarStyle,
      speed: speed ? Number(speed) : 1,
      width: dimension.width,
      height: dimension.height,
      title,
      captionsBurnedIn: Boolean(captions),
      background: backgroundColor ? { type: 'color', value: backgroundColor } : undefined,
    });

    res.status(202).json({ ...result, wordCount, preset, dimension });
  } catch (err) {
    next(err);
  }
});

router.get('/videos/:videoId', async (req, res, next) => {
  try {
    res.json(await getVideoStatus(req.params.videoId));
  } catch (err) {
    next(err);
  }
});

export default router;
