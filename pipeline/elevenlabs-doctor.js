#!/usr/bin/env node
// What can this ElevenLabs key actually do?
//
//   node pipeline/elevenlabs-doctor.js
//
// The key's permission panel lists "Image & Video Generation" and "Music
// Generation" as endpoints it can be granted. A toggle in a settings screen is
// good evidence that something exists and no evidence at all about its URL, its
// parameters or what it costs -- and inventing those is the one mistake that
// produces confident, working-looking code that fails at 13:07.
//
// So this asks. Every request here is a GET: it reads the account, the models
// and the voice list, and it spends nothing. Where an endpoint's shape is
// unknown it is probed with a HEAD-like GET and the server's own answer is
// printed verbatim -- 404 means it is not there, 405 means it is there and
// wants a different verb, 401 means the key lacks that permission.
//
// Prints no key; only its length and last four characters.

import { env } from '../src/config.js';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const API = 'https://api.elevenlabs.io';
const key = env('ELEVENLABS_API_KEY');

console.log('ElevenLabs');

if (!key) {
  console.log(`  ${bad('no ELEVENLABS_API_KEY')}`);
  process.exit(0);
}
console.log(`  ${dim(`key ${key.length} chars, ends ...${key.slice(-4)}`)}`);

async function get(path) {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: String(err.message) };
  }
}

// What the account has left. This is the number that decides whether generated
// media is affordable at all, so it is read before anything else.
const user = await get('/v1/user/subscription');
if (user.status === 200) {
  try {
    const s = JSON.parse(user.body);
    const used = s.character_count;
    const limit = s.character_limit;
    console.log(`  ${ok('account')} tier ${s.tier || '?'}  ·  ${used}/${limit} characters used`
      + `  ·  ${dim(`${Math.max(0, limit - used)} left`)}`);
  } catch {
    console.log(`  ${ok('account')} ${user.body.slice(0, 120)}`);
  }
} else {
  console.log(`  ${bad('account')} ${user.status}: ${user.body.slice(0, 160)}`);
}

// Which capabilities this key is actually permitted to touch. A restricted key
// answers 401 on the endpoints it was not granted, which is the cheapest way to
// read the toggles without opening the dashboard.
const PROBES = [
  ['models', '/v1/models'],
  ['voices', '/v1/voices'],
  ['music', '/v1/music'],
  ['image or video', '/v1/image-generation'],
  ['image alt path', '/v1/images'],
];

for (const [label, path] of PROBES) {
  const { status, body } = await get(path);
  const verdict = {
    200: ok('available'),
    401: bad('not permitted by this key'),
    403: bad('forbidden'),
    404: dim('no such endpoint'),
    405: ok('exists — needs POST, not GET'),
    422: ok('exists — needs parameters'),
  }[status] || `${status}`;

  console.log(`  ${label.padEnd(16)} ${verdict}  ${dim(String(body).replace(/\s+/g, ' ').slice(0, 90))}`);
}

console.log(dim('\n  Nothing was generated. Every request above was a GET.'));
