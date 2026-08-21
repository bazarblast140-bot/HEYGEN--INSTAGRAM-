// Voiceover for every second the avatar is not on screen.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createSpeech } from '../../../src/heygen.js';
import { env } from '../../../src/config.js';

export async function renderVoice({
  text,
  voiceId = env('HEYGEN_VOICE_ID'),
  speed = 1.02,
  locale = 'hi-IN',
  out,
}) {
  if (!voiceId) throw new Error('No voice id. Set HEYGEN_VOICE_ID in .env or pass voiceId.');

  const speech = await createSpeech({ text, voiceId, speed, locale });

  await fs.mkdir(path.dirname(out), { recursive: true });
  const res = await fetch(speech.audioUrl);
  if (!res.ok) throw new Error(`Downloading the TTS audio failed (${res.status})`);
  await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));

  return { file: out, duration: speech.duration, wordTimestamps: speech.wordTimestamps };
}
