// New publishing paths stay off until Rajesh approves a preview.
// A missing variable, an empty string, and "false" are all off.

export const ENABLE_AI_NEWS_CAROUSELS = 'ENABLE_AI_NEWS_CAROUSELS';
export const ENABLE_REEL_STORY = 'ENABLE_REEL_STORY';
export const ENABLE_CAROUSEL_STORY = 'ENABLE_CAROUSEL_STORY';

export function flagOn(name, env = process.env) {
  const value = String(env?.[name] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
