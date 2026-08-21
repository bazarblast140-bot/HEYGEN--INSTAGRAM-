// Burned-in captions, in the two-layer style the reference reels all use:
// ordinary words in bold white sans on the lower third, and one "power word" per
// line in large display-serif italic above them.
//
// Written as ASS rather than rendered as frames. ffmpeg burns a subtitle file in
// one pass over the finished video, where a second Playwright pass would mean
// another nine hundred screenshots for text that does not need a browser.
//
// Word timings come from HeyGen's TTS when it is available — it returns them for
// free — and are estimated from the beat's duration when it is not. Estimated
// timings drift on long lines, which is exactly why lines are kept short.

import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './encode.js';

const FRAME = { width: 1080, height: 1920 };

// Design pixels are 720-wide; ASS works in output pixels.
const STYLE = {
  sans: { font: 'Inter', size: 64, primary: '&H00F8FAFC', outline: '&H00020617' },
  serif: { font: 'Instrument Serif', size: 96, primary: '&H004CA1EF', outline: '&H00020617' },
};

const ts = (seconds) => {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
};

function header() {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${FRAME.width}`,
    `PlayResY: ${FRAME.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment 2 = bottom-centre. MarginV lifts the line clear of Instagram's own UI.
    // Two style pairs, because a caption is drawn over whatever ground the beat
    // uses. White text with a dark edge disappears on the cream card — the light
    // variants invert both so every line stays readable on its own background.
    `Style: Body,${STYLE.sans.font},${STYLE.sans.size},&H00F8FAFC,&H00020617,&H80000000,-1,0,1,5,2,2,80,80,300,1`,
    `Style: Power,${STYLE.serif.font},${STYLE.serif.size},&H004CA1EF,&H00020617,&H80000000,0,-1,1,5,2,2,80,80,430,1`,
    `Style: BodyLight,${STYLE.sans.font},${STYLE.sans.size},&H001F1814,&H00ECF1F4,&H80FFFFFF,-1,0,1,5,2,2,80,80,300,1`,
    `Style: PowerLight,${STYLE.serif.font},${STYLE.serif.size},&H000A53B4,&H00ECF1F4,&H80FFFFFF,0,-1,1,5,2,2,80,80,430,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
}

/**
 * Split a line into short caption groups. Two or three words at a time is what
 * the reference reels show — long enough to read, short enough that estimated
 * timings never drift far from the voice.
 */
export function groupWords(words, perGroup = 3) {
  const groups = [];
  for (let i = 0; i < words.length; i += perGroup) groups.push(words.slice(i, i + perGroup));
  return groups;
}

/**
 * Even timings across a beat. Used when the voice track carries no word timings —
 * a silent fallback, or a TTS engine that does not return them.
 */
function estimateTimings(words, start, duration) {
  const per = duration / Math.max(1, words.length);
  return words.map((word, i) => ({ word, start: start + i * per, end: start + (i + 1) * per }));
}

/**
 * @param {Array} beats  [{ start, duration, text, power, theme }]
 *   text  — spoken words for this beat
 *   power — the one word to set in display serif above the line, optional
 *   theme — the beat's ground, so the caption can invert on the light card
 */
export function buildAss(beats) {
  const lines = [header()];

  for (const beat of beats) {
    const words = String(beat.text || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    const light = beat.theme === 'light';
    const bodyStyle = light ? 'BodyLight' : 'Body';
    const powerStyle = light ? 'PowerLight' : 'Power';

    const timed = beat.timings?.length
      ? beat.timings
      : estimateTimings(words, beat.start, beat.duration);

    for (const group of groupWords(timed)) {
      const text = group.map((t) => t.word).join(' ').replace(/[{}]/g, '');
      lines.push(`Dialogue: 0,${ts(group[0].start)},${ts(group[group.length - 1].end)},${bodyStyle},,0,0,0,,${text}`);
    }

    if (beat.power) {
      // The power word holds for the whole beat rather than flashing per group —
      // it is the thing the viewer should still be reading when the shot changes.
      lines.push(
        `Dialogue: 1,${ts(beat.start)},${ts(beat.start + beat.duration)},${powerStyle},,0,0,0,,${String(beat.power).replace(/[{}]/g, '')}`,
      );
    }
  }

  return lines.join('\n') + '\n';
}

export async function burnCaptions({ video, beats, out, fontsDir }) {
  const assPath = path.join(path.dirname(out), 'captions.ass');
  await fs.writeFile(assPath, buildAss(beats));

  // fontsdir points at the bundled woff2 siblings; libass needs the family names
  // registered or it silently substitutes, which is how captions end up in the
  // wrong face without any error at all.
  const filter = `subtitles=${assPath.replace(/([:'\\])/g, '\\$1')}` +
    (fontsDir ? `:fontsdir=${fontsDir.replace(/([:'\\])/g, '\\$1')}` : '');

  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-i', video,
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart',
    out,
  ]);

  return out;
}
