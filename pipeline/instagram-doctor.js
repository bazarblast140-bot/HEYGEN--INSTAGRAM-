#!/usr/bin/env node
// Is the Instagram token usable, and how long will it last?
//
//   node pipeline/instagram-doctor.js
//
// Two separate questions, and only the first is obvious.
//
// "Does it work" is answered by resolving the configured IG_USER_ID through it.
// "How long" is the one that quietly costs a morning: a Page token derived from
// a SHORT-lived user token is itself short-lived, about an hour, and it behaves
// exactly like a permanent one until it doesn't. The same token that publishes
// fine at noon fails at 7am tomorrow with an error that reads like a revoked
// app rather than an expiry.
//
// debug_token answers it outright — "never" for a Page token built on a
// long-lived user token, a date for one that was not. So the answer is read from
// Facebook rather than assumed from how the token was obtained.
//
// Publishes nothing. Prints no token; only its length and last four characters,
// which is enough to tell two pasted values apart and not enough to use one.

import { whoami } from './src/publish/instagram.js';
import { inspect } from './src/publish/token.js';
import { env } from '../src/config.js';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const token = env('IG_ACCESS_TOKEN');
const userId = env('IG_USER_ID');
const surface = env('IG_SURFACE') || '(default)';

console.log('Instagram');

if (!token) {
  console.log(`  ${bad('no IG_ACCESS_TOKEN')}`);
  console.log(dim('  Settings → Secrets and variables → Actions → new secret IG_ACCESS_TOKEN.'));
  console.log(dim('  A Page token read from /PAGE_ID?fields=access_token is exactly the value wanted;'));
  console.log(dim('  it does not need any further exchange.'));
  process.exit(0);
}

console.log(`  ${dim(`token ${token.length} chars, ends ...${token.slice(-4)}  ·  surface ${surface}  ·  user ${userId || '(unset)'}`)}`);

// Does it resolve to the account we think it does?
try {
  const me = await whoami({ igUserId: userId, token });
  const label = me?.username ? `@${me.username}` : (me?.name || JSON.stringify(me).slice(0, 80));
  console.log(`  ${ok('WORKS')} resolves to ${label}`);
} catch (err) {
  console.log(`  ${bad('fail ')} ${String(err.message).slice(0, 200)}`);
}

// How long does it last? This is the question that decides whether the setup is
// finished or merely working right now.
try {
  const info = await inspect({ token });
  const permanent = info.expiresAt === 'never';

  console.log(`  ${info.valid ? ok('valid') : bad('invalid')} type ${info.type || '?'}  ·  expires ${permanent ? ok('never') : warn(info.expiresAt)}`);

  if (!permanent) {
    console.log(warn('  This token expires. It works today and will stop without warning.'));
    console.log(dim('  Cause: the Page token was taken from a short-lived user token. Run the'));
    console.log(dim('  "Set up Instagram token" workflow to exchange it for one that does not expire.'));
  }

  // Publishing needs both of these; a token that resolves but cannot post is a
  // failure that only shows up at the last step.
  const needed = ['instagram_basic', 'instagram_content_publish'];
  const missing = needed.filter((s) => !info.scopes.includes(s));
  if (missing.length) {
    console.log(`  ${bad('missing scope(s)')} ${missing.join(', ')}`);
    console.log(dim('  Re-generate the token in Graph API Explorer with those permissions ticked.'));
  } else {
    console.log(`  ${ok('scopes ok')} ${dim(needed.join(', '))}`);
  }
} catch (err) {
  console.log(`  ${dim(`could not inspect the token: ${String(err.message).slice(0, 140)}`)}`);
}
