// Cross-post to the Facebook Page linked to the Instagram account.
//
// Instagram is the job; Facebook is a copy. Nothing here may ever change the
// outcome of an Instagram post: callers run it after the IG publish succeeded,
// and every failure is reported, never thrown past the CLI.
//
// Off unless the repository variable FB_CROSSPOST is exactly "true".

import fs from 'node:fs';

const VERSION = process.env.IG_API_VERSION || 'v23.0';
const GRAPH = 'https://graph.facebook.com';

export const NEEDED_SCOPES = ['pages_manage_posts', 'pages_read_engagement'];

export function enabled(env = process.env) {
  return String(env.FB_CROSSPOST || '').trim().toLowerCase() === 'true';
}

export async function graph(pathname, { method = 'GET', params = {}, token, fetchImpl = fetch } = {}) {
  const url = new URL(`${GRAPH}/${VERSION}/${pathname}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = await fetchImpl(method === 'GET' ? `${url}?${body}` : url, {
    method, ...(method === 'GET' ? {} : { body }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.error) {
    const e = payload.error || {};
    throw Object.assign(
      new Error(`Facebook ${method} ${url.pathname} failed: ${e.message || res.status}${e.code ? ` (code ${e.code})` : ''}`),
      { status: res.status, details: payload },
    );
  }
  return payload;
}

/** Which Page this token speaks for, and what it is allowed to do there. Never prints the token. */
export async function whoami({ token, pageId, fetchImpl = fetch }) {
  const me = await graph('me', { params: { fields: 'id,name' }, token, fetchImpl });
  let scopes = [];
  let type = '?';
  try {
    const { data } = await graph('debug_token', { params: { input_token: token }, token, fetchImpl });
    scopes = data?.scopes || [];
    type = data?.type || '?';
  } catch { /* scopes stay unknown */ }
  let page = null;
  if (pageId && String(pageId) !== String(me.id)) {
    page = await graph(String(pageId), { params: { fields: 'id,name' }, token, fetchImpl }).catch(() => null);
  }
  const missing = NEEDED_SCOPES.filter((s) => !scopes.includes(s));
  return {
    id: me.id, name: me.name, type, scopes, missing,
    pageMatches: !pageId || String(pageId) === String(me.id),
    page,
  };
}

/** A carousel becomes one Page post with several photos, in slide order. */
export async function crossPostCarousel({ pageId, token, imageUrls, caption, fetchImpl = fetch }) {
  if (!imageUrls?.length) throw new Error('no image URLs to cross-post');
  const ids = [];
  for (const url of imageUrls) {
    const { id } = await graph(`${pageId}/photos`, {
      method: 'POST', params: { url, published: 'false' }, token, fetchImpl,
    });
    ids.push(id);
  }
  const params = { message: caption || '' };
  ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  const { id } = await graph(`${pageId}/feed`, { method: 'POST', params, token, fetchImpl });
  return { id, url: `https://www.facebook.com/${id}` };
}

/** A Reel becomes a Facebook Reel on the Page, fetched from the same public URL. */
export async function crossPostReel({ pageId, token, videoUrl, caption, fetchImpl = fetch }) {
  if (!videoUrl) throw new Error('no video URL to cross-post');
  const start = await graph(`${pageId}/video_reels`, {
    method: 'POST', params: { upload_phase: 'start' }, token, fetchImpl,
  });
  const videoId = start.video_id;
  const uploadUrl = start.upload_url || `https://rupload.facebook.com/video-upload/${VERSION}/${videoId}`;
  const up = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
  });
  const upBody = await up.json().catch(() => ({}));
  if (!up.ok || upBody.success === false || upBody.error) {
    throw new Error(`Facebook reel upload failed: ${upBody.error?.message || upBody.debug_info?.message || up.status}`);
  }
  await graph(`${pageId}/video_reels`, {
    method: 'POST',
    params: { upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: caption || '' },
    token, fetchImpl,
  });
  return { id: videoId, url: `https://www.facebook.com/reel/${videoId}` };
}

// The ledger: one line per Instagram media id that has been copied. A second
// run for the same media id is skipped, so a re-run never double-posts.
export function readLedger(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

export function alreadyCrossPosted(ledger, igMediaId) {
  return ledger.some((e) => String(e.igMediaId) === String(igMediaId));
}

export function record(file, entry, keep = 200) {
  const ledger = readLedger(file);
  ledger.push(entry);
  fs.writeFileSync(file, `${JSON.stringify(ledger.slice(-keep), null, 2)}\n`);
}

/** IST calendar day, the day every other ledger in this repo uses. */
export function istDay(now = new Date()) {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}
