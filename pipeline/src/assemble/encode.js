// Frame sequence -> MP4, at the settings Instagram actually wants.

import { spawn } from 'node:child_process';
import path from 'node:path';

export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-2500)}`)),
    );
  });
}

export async function encodeFrames({ frameDir, out, fps = 30, crf = 18 }) {
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-framerate', String(fps),
    '-i', path.join(frameDir, '%05d.png'),
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', String(crf),
    // yuv420p + even dimensions, or the file plays green/black on iOS.
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    out,
  ]);
  return out;
}

/** Probe an encoded file so the QC gate asserts on the real output, not on intent. */
export async function probe(file) {
  const json = await new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error', '-print_format', 'json',
      '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames',
      file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr))));
  });

  const video = json.streams.find((s) => s.codec_type === 'video');
  const [num, den] = String(video.r_frame_rate).split('/').map(Number);

  return {
    duration: Number(json.format.duration),
    sizeBytes: Number(json.format.size),
    width: video.width,
    height: video.height,
    fps: den ? num / den : num,
    frames: video.nb_frames ? Number(video.nb_frames) : null,
    hasAudio: json.streams.some((s) => s.codec_type === 'audio'),
  };
}
