// Free narration fallback: Microsoft Edge's read-aloud voices, via the edge-tts
// CLI. No key, no account, and it has real hi-IN voices — which matters because
// Hinglish read by an English voice mangles every Hindi word in it.
//
// This is a fallback, not the plan: the cloned HeyGen voice is the one that sounds
// like Rajesh. But a reel with a stranger's voice beats a reel with no voice, and
// silence was the loudest thing wrong with the first cut.
//
// UNVERIFIED here: this environment's proxy refuses the WebSocket upgrade the CLI
// needs (403), so it could not be run end to end locally. It reaches the host and
// completes TLS, and a GitHub runner has no such proxy in the way.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_VOICE = process.env.EDGE_TTS_VOICE || 'hi-IN-MadhurNeural';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => reject(new Error(`${cmd} could not be started: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-400)}`))));
  });
}

/** Parse edge-tts's WebVTT word boundaries into the shape the caption engine wants. */
function parseBoundaries(vtt) {
  const cues = [];
  const time = (s) => {
    const [h, m, rest] = s.split(':');
    return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(',', '.'));
  };

  const lines = vtt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^([\d:.,]+)\s+-->\s+([\d:.,]+)/);
    if (!match) continue;
    const word = (lines[i + 1] || '').trim();
    if (word) cues.push({ word, start: time(match[1]), end: time(match[2]) });
  }
  return cues;
}

export async function renderEdgeVoice({ text, out, voice = DEFAULT_VOICE, rate = '+6%' }) {
  await fs.mkdir(path.dirname(out), { recursive: true });

  const mp3 = out.replace(/\.\w+$/, '.mp3');
  const vtt = out.replace(/\.\w+$/, '.vtt');

  // A slight rate lift reads as energy; the default pace is noticeably flat
  // against a 104 BPM bed.
  await run('edge-tts', [
    '--voice', voice,
    '--rate', rate,
    '--text', text.trim(),
    '--write-media', mp3,
    '--write-subtitles', vtt,
  ]);

  // Normalise to the wav the mixer expects.
  await run('ffmpeg', ['-y', '-v', 'error', '-i', mp3, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out]);

  let wordTimestamps = [];
  try {
    wordTimestamps = parseBoundaries(await fs.readFile(vtt, 'utf8'));
  } catch {
    // Word boundaries are a bonus; captions fall back to estimated timings.
  }

  return { file: out, voice, wordTimestamps };
}
