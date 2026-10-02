// Public competitor and hashtag data, via the Instagram Graph API only.
// A missing permission or an unknown handle is a skip, not a failed run.

import { HASHTAG_WEEKLY_CAP, hashtagBudget, patternFromMedia } from './patterns.js';

const VERSION = process.env.IG_API_VERSION || 'v23.0';

const MEDIA_FIELDS = 'caption,media_type,media_product_type,like_count,comments_count,timestamp,permalink';

export function permissionError(error) {
  const code = Number(error?.code);
  const message = String(error?.message || error || '');
  return [10, 100, 190, 200, 803].includes(code)
    || /permission|not authorized|does not exist|unsupported get|invalid user|unknown|oauth/i.test(message);
}

async function graphGet(url, fetchImpl) {
  const res = await fetchImpl(url);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.error) {
    const error = payload.error || {};
    throw Object.assign(new Error(error.message || `HTTP ${res.status}`), {
      code: error.code,
      status: res.status,
    });
  }
  return payload;
}

function host() {
  return process.env.IG_API_HOST || 'https://graph.facebook.com';
}

export async function discoverAccount({ igUserId, token, username, fetchImpl = fetch, fetchedAt }) {
  const handle = String(username || '').replace(/[^A-Za-z0-9._]/g, '');
  if (!handle) return { skipped: true, username, reason: 'empty handle' };
  const fields = `business_discovery.username(${handle}){username,followers_count,media.limit(8){${MEDIA_FIELDS}}}`;
  const url = `${host()}/${VERSION}/${igUserId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`;
  try {
    const payload = await graphGet(url, fetchImpl);
    const account = payload.business_discovery;
    if (!account?.username) return { skipped: true, username: handle, reason: 'no business_discovery payload' };
    const media = account.media?.data || [];
    const patterns = media.map((item) => patternFromMedia(item, {
      followers: account.followers_count,
      username: account.username,
      source: 'business_discovery',
      fetchedAt,
    }));
    return { skipped: false, username: account.username, followers: account.followers_count, patterns };
  } catch (error) {
    if (permissionError(error)) return { skipped: true, username: handle, reason: error.message };
    return { skipped: true, username: handle, reason: error.message };
  }
}

export async function searchHashtag({ igUserId, token, hashtag, fetchImpl = fetch, fetchedAt }) {
  const tag = String(hashtag || '').replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  if (!tag) return { skipped: true, hashtag, reason: 'empty hashtag', patterns: [] };
  const searchUrl = `${host()}/${VERSION}/ig_hashtag_search?user_id=${encodeURIComponent(igUserId)}&q=${encodeURIComponent(tag)}&access_token=${encodeURIComponent(token)}`;
  try {
    const found = await graphGet(searchUrl, fetchImpl);
    const id = found.data?.[0]?.id;
    if (!id) return { skipped: true, hashtag: tag, reason: 'hashtag id not found', patterns: [] };
    const mediaUrl = `${host()}/${VERSION}/${id}/top_media?user_id=${encodeURIComponent(igUserId)}&fields=${MEDIA_FIELDS}&access_token=${encodeURIComponent(token)}`;
    const media = await graphGet(mediaUrl, fetchImpl);
    const patterns = (media.data || []).slice(0, 6).map((item) => patternFromMedia(item, {
      source: 'ig_hashtag_search',
      username: null,
      fetchedAt,
    }));
    return { skipped: false, hashtag: tag, patterns };
  } catch (error) {
    return { skipped: true, hashtag: tag, reason: error.message, permission: permissionError(error), patterns: [] };
  }
}

export async function collectResearch({
  competitors,
  token,
  igUserId,
  previous,
  now = new Date(),
  fetchImpl = fetch,
  onNote,
} = {}) {
  const fetchedAt = now.toISOString();
  const notes = [];
  const patterns = [];
  if (!token || !igUserId) {
    notes.push('skipped: IG_ACCESS_TOKEN or IG_USER_ID missing');
    onNote?.(notes[0]);
    return { patterns, notes, hashtagSearch: hashtagBudget(previous, now) };
  }

  for (const account of competitors?.accounts || []) {
    const result = await discoverAccount({
      igUserId, token, username: account.username, fetchImpl, fetchedAt,
    });
    if (result.skipped) {
      const line = `skip @${account.username}: ${result.reason}`;
      notes.push(line);
      onNote?.(line);
      continue;
    }
    patterns.push(...result.patterns);
    onNote?.(`@${result.username}: ${result.patterns.length} posts`);
  }

  const budget = hashtagBudget(previous, now);
  let used = budget.used;
  const tags = competitors?.hashtags || [];
  for (const tag of tags) {
    if (used >= HASHTAG_WEEKLY_CAP) {
      notes.push(`hashtag budget spent (${HASHTAG_WEEKLY_CAP}/week)`);
      onNote?.(notes.at(-1));
      break;
    }
    const result = await searchHashtag({ igUserId, token, hashtag: tag, fetchImpl, fetchedAt });
    used += 1;
    if (result.skipped) {
      const line = `skip #${tag}: ${result.reason}`;
      notes.push(line);
      onNote?.(line);
      if (result.permission) break;
      continue;
    }
    patterns.push(...result.patterns);
    onNote?.(`#${tag}: ${result.patterns.length} posts`);
  }

  return {
    patterns,
    notes,
    hashtagSearch: { week: budget.week, used },
  };
}
