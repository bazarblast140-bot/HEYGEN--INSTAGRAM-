// Keep a finished reel inside 20–30 seconds.
//
// A script that runs a second or two long is sped up slightly. One that is
// far outside the window is rejected rather than pitched up until it sounds
// wrong. Instagram's own limits (under 3s, over 90s) stay in the build.

export const REEL_MIN_SECONDS = 20;
export const REEL_MAX_SECONDS = 30;

export function fitPlan(seconds, { min = REEL_MIN_SECONDS, max = REEL_MAX_SECONDS, limit = 1.15 } = {}) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return { action: 'reject', factor: 1, target: n };
  if (n >= min && n <= max) return { action: 'keep', factor: 1, target: n };
  if (n > max && n / (max - 0.5) <= limit) {
    return { action: 'speed', factor: n / (max - 0.5), target: max - 0.5 };
  }
  if (n < min && min / n <= limit) {
    return { action: 'slow', factor: n / min, target: min };
  }
  return { action: 'reject', factor: 1, target: n };
}
