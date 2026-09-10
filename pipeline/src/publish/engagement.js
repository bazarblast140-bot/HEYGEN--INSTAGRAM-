// What each post actually did.
//
// Reach, saves and shares are the numbers that matter and this token may not
// read them -- the account's insights edge answers "(#10) Application does not
// have permission". Likes and comments sit on the media node itself and need
// nothing extra, so they are what there is, and they are enough to answer the
// only question being asked: does finance outperform facts on this account?
//
// Instagram does not tell us which carousel a post was. The topic ledger knows
// what went out on which date and slot, and a post's timestamp says which slot
// it belongs to, so the two are joined on that.

import { call } from './instagram.js';

/** IST is UTC+5:30, and the slots are 06:07, 13:07 and 17:07 there. */
export function slotOfPost(timestamp) {
  const t = new Date(timestamp);
  if (Number.isNaN(t.getTime())) return null;
  const ist = new Date(t.getTime() + (5.5 * 60 * 60 * 1000));
  const hour = ist.getUTCHours();
  if (hour < 11) return 'morning';
  if (hour < 16) return 'midday';
  return 'evening';
}

export function dateOfPost(timestamp) {
  const t = new Date(timestamp);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(t.getTime() + (5.5 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

export async function fetchPosts({ igUserId, token, surface, limit = 60 }) {
  const { data = [] } = await call(`${igUserId}/media`, {
    token, surface,
    params: {
      fields: 'id,timestamp,media_type,permalink,like_count,comments_count,caption',
      limit: String(limit),
    },
  });

  return data.map((m) => ({
    id: m.id,
    date: dateOfPost(m.timestamp),
    slot: slotOfPost(m.timestamp),
    type: m.media_type,
    likes: m.like_count ?? null,
    comments: m.comments_count ?? null,
    hook: String(m.caption || '').split('\n')[0].slice(0, 80),
    permalink: m.permalink,
  })).filter((p) => p.date);
}

/**
 * Join what was posted to how it did.
 *
 * A ledger entry with no matching post is a day the post did not go out, and
 * that is worth seeing too -- it is the difference between a bad post and no
 * post, and only one of those is a content problem.
 */
export function join(entries, posts) {
  const byKey = new Map(posts.map((p) => [`${p.date} ${p.slot}`, p]));
  return entries.map((e) => {
    const post = byKey.get(e.date) || null;
    return {
      date: e.date,
      angle: e.angle || null,
      topic: e.topic,
      likes: post?.likes ?? null,
      comments: post?.comments ?? null,
      permalink: post?.permalink ?? null,
    };
  });
}

/** Average likes per angle, best first, with the count so one lucky post is visible. */
export function byAngle(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.likes == null || !r.angle) continue;
    const g = groups.get(r.angle) || { angle: r.angle, posts: 0, likes: 0, best: null };
    g.posts += 1;
    g.likes += r.likes;
    if (!g.best || r.likes > g.best.likes) g.best = r;
    groups.set(r.angle, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, average: g.likes / g.posts }))
    .sort((a, b) => b.average - a.average);
}
