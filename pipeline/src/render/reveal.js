// When the hook text is actually on screen.
//
// The card scene fades the headline in from frame 3 to frame 20. At 30fps that
// is about 0.7s, so a cover grabbed from frame 0 is a blank card. The opening
// hook is drawn fully opaque on frame 0 instead, and the cover is taken then.

export const HOOK_REVEAL_FRAME = 20;
export const FPS = 30;

export function hookOpacity(frame, { instant = false, start = 3, end = HOOK_REVEAL_FRAME } = {}) {
  if (instant) return 1;
  const t = Math.min(1, Math.max(0, (frame - start) / (end - start)));
  return 1 - (1 - t) ** 5;
}

/** Seconds to seek so the cover shows the hook, not the fade. */
export function coverTimestamp({ instant = true, fps = FPS, revealFrame = HOOK_REVEAL_FRAME } = {}) {
  const frame = instant ? 0 : revealFrame;
  return frame / fps;
}
