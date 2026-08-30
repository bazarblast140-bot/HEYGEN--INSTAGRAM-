#!/usr/bin/env node
// Which script-writing key actually works?
//
//   node pipeline/script-doctor.js
//
// "The secret is set" and "the vendor accepts it" look identical from the
// outside, and the difference has already cost a day: a run reported
// MOONSHOT_API_KEY present and then failed with Invalid Authentication, which
// reads like a missing secret and is not one.
//
// So each configured key is put to the vendor and the vendor's own answer is
// printed. /models is the cheapest question that requires authentication —
// it spends no tokens, generates nothing, and a 200 means the key is live.
//
// Prints no secrets. A key is described by length and last four characters,
// which is enough to tell two pasted keys apart and not enough to use one.

import { VENDORS } from './src/script/providers.js';
import { env } from '../src/config.js';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const shape = (key) => `${key.length} chars, ends ...${key.slice(-4)}`;

/** Anthropic is not OpenAI-compatible: different header, and a version is required. */
async function checkAnthropic(key) {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  });
  return { status: res.status, body: await res.text() };
}

async function checkOpenAiCompatible(baseUrl, key) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  return { status: res.status, body: await res.text() };
}

/** A vendor's refusal says which of the two problems it is, so it is quoted. */
function verdict(status, body) {
  if (status === 200) return { good: true, why: 'key accepted' };

  let detail = body.replace(/\s+/g, ' ').slice(0, 140);
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message || parsed?.message || detail;
  } catch { /* not JSON; the raw head is more use than nothing */ }

  if (status === 401) return { good: false, why: `rejected the key — ${detail}` };
  if (status === 402) return { good: false, why: `key valid, no balance — ${detail}` };
  if (status === 429) return { good: false, why: `rate limited — ${detail}` };
  return { good: false, why: `HTTP ${status} — ${detail}` };
}

const rows = [];

if (env('ANTHROPIC_API_KEY')) {
  rows.push(['anthropic', env('ANTHROPIC_API_KEY'), () => checkAnthropic(env('ANTHROPIC_API_KEY'))]);
}
for (const [name, vendor] of Object.entries(VENDORS)) {
  const key = env(vendor.key);
  if (key) rows.push([name, key, () => checkOpenAiCompatible(vendor.baseUrl, key)]);
}

console.log('Script providers');

if (!rows.length) {
  console.log(`  ${bad('none configured')}`);
  console.log(dim('  Set any one of: ANTHROPIC_API_KEY, ' + Object.values(VENDORS).map((v) => v.key).join(', ')));
  console.log(dim('  Without one the carousel and the reel both fall back to the checked-in spec,'));
  console.log(dim('  which means the same post every day.'));
  process.exit(0);
}

let working = 0;
for (const [name, key, check] of rows) {
  try {
    const { status, body } = await check();
    const { good, why } = verdict(status, body);
    console.log(`  ${good ? ok('WORKS') : bad('fail ')} ${name.padEnd(12)} ${dim(shape(key))}`);
    console.log(`        ${dim(why)}`);
    if (good) working += 1;
  } catch (err) {
    console.log(`  ${bad('err  ')} ${name.padEnd(12)} ${dim(String(err.message).slice(0, 120))}`);
  }
}

console.log();
if (working) {
  console.log(ok(`${working} of ${rows.length} configured key(s) work — the script can be written.`));
} else {
  console.log(bad(`All ${rows.length} configured key(s) were refused.`));
  console.log(dim('  A refused key is not a missing one. Re-issue it at the vendor, or add a second'));
  console.log(dim('  provider — the resolver takes whichever key is present, so one working key is enough.'));
}
