import 'dotenv/config';

export const config = {
  apiKey: process.env.HEYGEN_API_KEY || '',
  port: Number(process.env.PORT) || 3000,
  defaultAvatarId: process.env.DEFAULT_AVATAR_ID || '',
  defaultVoiceId: process.env.DEFAULT_VOICE_ID || '',
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
