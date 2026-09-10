#!/usr/bin/env node
// What can this Instagram token actually measure and publish?
//
//   node pipeline/insights-doctor.js
//
// Everything the account should do next depends on two facts nobody has
// checked: whether we may read how a post performed, and whether we may post a
// Story. Both are permissions, not features -- a Business account has them and
// a token only has them if the scope was granted.
//
// The publishing scopes we know we have are instagram_basic and
// instagram_content_publish. Insights needs instagram_manage_insights, which is
// a different grant, and asking the API is the only way to find out. Guessing
// would produce confident code that returns nothing at 06:07.
//
// Read-only. It reads the account, the last few posts and their metrics, and
// it publishes nothing -- the Story check asks for the container field list
// without creating one.

import { env } from '../src/config.js';
import { call } from './src/publish/instagram.js';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const igUserId = env('IG_USER_ID');
const token = env('IG_ACCESS_TOKEN');
const surface = env('IG_SURFACE') || 'facebook';

if (!token || !igUserId) {
  console.log(bad('No IG_ACCESS_TOKEN or IG_USER_ID.'));
  process.exit(0);
}

const attempt = async (label, run) => {
  try {
    const value = await run();
    console.log(`  ${ok(label)} ${dim(value)}`);
    return true;
  } catch (err) {
    console.log(`  ${bad(label)} ${String(err.message).slice(0, 150)}`);
    return false;
  }
};

console.log('Instagram — what this token may do\n');

await attempt('account', async () => {
  const me = await call(igUserId, { token, surface, params: { fields: 'username,followers_count,media_count' } });
  return `@${me.username} · ${me.followers_count ?? '?'} followers · ${me.media_count} posts`;
});

// The last few posts, with whatever engagement the media node itself carries.
// like_count and comments_count sit on the media object and need no insights
// permission; reach and saves do.
let recent = [];
await attempt('recent posts', async () => {
  const res = await call(`${igUserId}/media`, {
    token, surface,
    params: { fields: 'id,caption,timestamp,media_type,permalink,like_count,comments_count', limit: '8' },
  });
  recent = res.data || [];
  const totals = recent.reduce((a, m) => ({
    likes: a.likes + (m.like_count || 0),
    comments: a.comments + (m.comments_count || 0),
  }), { likes: 0, comments: 0 });
  return `${recent.length} read · ${totals.likes} likes, ${totals.comments} comments between them`;
});

for (const m of recent.slice(0, 5)) {
  const when = String(m.timestamp || '').slice(0, 10);
  const first = String(m.caption || '').split('\n')[0].slice(0, 46);
  console.log(dim(`      ${when}  ${String(m.like_count ?? '?').padStart(3)} likes  ${String(m.comments_count ?? '?').padStart(2)} comments  ${first}`));
}

// The number that matters more than likes: how many people it reached.
if (recent[0]) {
  await attempt('post insights', async () => {
    const res = await call(`${recent[0].id}/insights`, {
      token, surface, params: { metric: 'reach,saved,shares,profile_visits' },
    });
    return (res.data || []).map((d) => `${d.name} ${d.values?.[0]?.value}`).join(' · ') || 'no values';
  });
}

await attempt('account insights', async () => {
  const res = await call(`${igUserId}/insights`, {
    token, surface, params: { metric: 'reach', period: 'day', metric_type: 'total_value' },
  });
  return (res.data || []).map((d) => `${d.name} ${d.total_value?.value ?? d.values?.[0]?.value}`).join(' · ') || 'no values';
});

// Stories. Asking for the account's stories needs the same permission family as
// posting one, so a refusal here is the answer for both.
await attempt('stories', async () => {
  const res = await call(`${igUserId}/stories`, { token, surface, params: { fields: 'id' } });
  return `readable — ${(res.data || []).length} live now`;
});

console.log(dim('\n  Nothing was published. Every request above was a read.'));
