// The same Story on the Facebook Page, after every Instagram Story we post.
//
//   carousel Story frame  → photo story: POST /{page}/photos {url, published:false}
//                           then POST /{page}/photo_stories {photo_id}
//   Reel companion Story  → video story: POST /{page}/video_stories {upload_phase:start}
//                           → POST upload_url with header file_url=<re-hosted URL>
//                           → POST /{page}/video_stories {upload_phase:finish, video_id}
//
// Rules:
//   * Off unless FB_CROSSPOST is exactly "true", FB_PAGE_ID is set and the
//     FB_PAGE_TOKEN secret is present (the Page token only; no fallback).
//   * Never throws. A failure is a clearly logged Graph error and nothing else:
//     it cannot fail the job or touch the IG post, the IG Story or the FB post.
//   * Never a Meta CDN URL (Graph refuses first-party Meta URLs): only the
//     re-hosted GitHub release URL is handed over.
//   * Ledger pipeline/fb-story-history.json, keyed on the Instagram Story's
//     media id: one FB Story per IG Story, ever. A result whose response was
//     lost after the final publish call is "uncertain" and is never retried.
//     Nothing is backfilled: this only runs right after a new IG Story.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { graph } from './facebook.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FB_STORY_LEDGER = path.resolve(HERE, '..', '..', 'fb-story-history.json');
const VERSION = process.env.IG_API_VERSION || 'v23.0';

export function storyEnabled(env = process.env) {
  return String(env.FB_CROSSPOST || '').trim().toLowerCase() === 'true'
    && Boolean(String(env.FB_PAGE_ID || '').trim()) && Boolean(env.FB_PAGE_TOKEN);
}

const META_HOSTS = /(^|\.)(fbcdn\.net|cdninstagram\.com|facebook\.com|fbsbx\.com|instagram\.com|fb\.com|whatsapp\.net)$/i;

/** True for a Meta-hosted URL (Graph refuses those as story sources). */
export function isMetaCdn(url) {
  try { return META_HOSTS.test(new URL(String(url)).hostname); } catch { return false; }
}

const HINTS = {
  10: 'permission denied — the Page token needs pages_manage_posts (+ pages_read_engagement, pages_show_list) and the CREATE_CONTENT task on the Page',
  200: 'permission error — the Page token needs pages_manage_posts and the CREATE_CONTENT task on the Page',
  190: 'the FB_PAGE_TOKEN is invalid or expired — create a new Page access token',
  100: 'invalid parameter — check the media URL is public, not Meta-hosted, and the photo/video meets Story limits (video ≤ 60 s)',
  368: 'the Page is temporarily blocked from posting',
  4: 'app-level rate limit — try later',
  32: 'Page-level rate limit — try later',
  613: 'rate limit — try later',
};

/** One readable line for a Graph failure: message, codes, fbtrace id and a hint. No token. */
export function explainFbError(err) {
  const e = err?.details?.error || err?.graph || {};
  const code = e.code ?? err?.code;
  const parts = [String(e.message || err?.message || err || 'unknown error').replace(/access_token=[^&\s"']+/gi, 'access_token=***')];
  if (code !== undefined) parts.push(`code ${code}${e.error_subcode ? `/${e.error_subcode}` : ''}`);
  if (e.type) parts.push(e.type);
  if (e.fbtrace_id) parts.push(`fbtrace ${e.fbtrace_id}`);
  if (err?.status) parts.push(`HTTP ${err.status}`);
  const hint = HINTS[code];
  return `${parts.join(' · ')}${hint ? ` — ${hint}` : ''}`.slice(0, 600);
}

/** Photo story: unpublished photo, then photo_stories. Returns the story post id. */
export async function postPhotoStory({ pageId, token, imageUrl, fetchImpl = fetch, onStage }) {
  if (!imageUrl) throw new Error('no image URL for the Facebook photo story');
  if (isMetaCdn(imageUrl)) throw new Error(`refusing a Meta CDN URL for the Facebook story (${new URL(imageUrl).hostname})`);
  onStage?.('photo');
  const { id: photoId } = await graph(`${pageId}/photos`, {
    method: 'POST', params: { url: imageUrl, published: 'false' }, token, fetchImpl,
  });
  if (!photoId) throw new Error('Facebook returned no photo id');
  onStage?.('publish');
  const out = await graph(`${pageId}/photo_stories`, { method: 'POST', params: { photo_id: String(photoId) }, token, fetchImpl });
  if (out.success === false) throw Object.assign(new Error('Facebook photo_stories returned success=false'), { details: out });
  return String(out.post_id || out.id || '');
}

/** Video story: start, upload by file_url (re-hosted URL), finish. Returns the story post id. */
export async function postVideoStory({ pageId, token, videoUrl, fetchImpl = fetch, onStage }) {
  if (!videoUrl) throw new Error('no video URL for the Facebook video story');
  if (isMetaCdn(videoUrl)) throw new Error(`refusing a Meta CDN URL for the Facebook story (${new URL(videoUrl).hostname})`);
  onStage?.('start');
  const start = await graph(`${pageId}/video_stories`, { method: 'POST', params: { upload_phase: 'start' }, token, fetchImpl });
  const videoId = start.video_id;
  if (!videoId) throw new Error('Facebook video_stories start returned no video_id');
  const uploadUrl = start.upload_url || `https://rupload.facebook.com/video-upload/${VERSION}/${videoId}`;
  onStage?.('upload');
  const up = await fetchImpl(uploadUrl, { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_url: videoUrl } });
  const upBody = await up.json().catch(() => ({}));
  if (!up.ok || upBody.success === false || upBody.error) {
    throw Object.assign(
      new Error(`Facebook video story upload failed: ${upBody.error?.message || upBody.debug_info?.message || `HTTP ${up.status}`}`),
      { status: up.status, details: upBody.error ? upBody : { error: { message: upBody.debug_info?.message } } },
    );
  }
  // Past this point a lost response may still mean a live story: "uncertain".
  onStage?.('publish');
  const out = await graph(`${pageId}/video_stories`, {
    method: 'POST', params: { upload_phase: 'finish', video_id: String(videoId) }, token, fetchImpl,
  });
  if (out.success === false) throw Object.assign(new Error('Facebook video_stories finish returned success=false'), { details: out });
  return String(out.post_id || out.id || videoId);
}

// ---------------------------------------------------------------- ledger

export function readStoryLedger(file = FB_STORY_LEDGER) {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

/** Merge two copies of the ledger: one row per IG Story, a done/uncertain row wins over a failed one. */
export function mergeStoryLedger(a = [], b = []) {
  const rank = (r) => (['done', 'uncertain'].includes(r?.state) ? 2 : 1);
  const by = new Map();
  const order = [];
  for (const row of [...a, ...b]) {
    const key = String(row?.igStoryId || JSON.stringify(row));
    if (!by.has(key)) { by.set(key, row); order.push(key); } else if (rank(row) > rank(by.get(key))) by.set(key, row);
  }
  return order.map((k) => by.get(k));
}

export function writeStoryLedger(file, rows, keep = 400) {
  fs.writeFileSync(file, `${JSON.stringify(rows.slice(-keep), null, 2)}\n`);
}

/** The ledger row that blocks another FB Story for this IG Story (done / uncertain), or null. */
export function storyBlocked(rows, igStoryId) {
  return rows.find((r) => String(r?.igStoryId) === String(igStoryId) && ['done', 'uncertain'].includes(r?.state)) || null;
}

const istDay = (now) => new Date(now + 330 * 60000).toISOString().slice(0, 10);

/**
 * Post the Facebook Story for one Instagram Story. Never throws.
 * kind: 'photo' (carousel frame) | 'video' (Reel companion).
 * Returns { state: 'done'|'skipped'|'failed'|'uncertain', fbStoryId?, reason?, error? }.
 */
export async function fbStory({
  kind, igStoryId, igMediaId = '', url, source = '', env = process.env,
  file = FB_STORY_LEDGER, fetchImpl = fetch, now = Date.now(), log = (l) => console.log(l),
} = {}) {
  const tag = `Facebook Story for IG Story ${igStoryId || '?'}`;
  try {
    if (String(env.FB_CROSSPOST || '').trim().toLowerCase() !== 'true') return { state: 'skipped', reason: 'FB_CROSSPOST is not true' };
    if (!env.FB_PAGE_ID) { log(`${tag}: skipped — FB_PAGE_ID is not set`); return { state: 'skipped', reason: 'no FB_PAGE_ID' }; }
    if (!env.FB_PAGE_TOKEN) { log(`${tag}: skipped — the FB_PAGE_TOKEN secret is not set`); return { state: 'skipped', reason: 'no FB_PAGE_TOKEN' }; }
    if (!/^\d+$/.test(String(igStoryId || ''))) { log(`${tag}: skipped — no Instagram Story id`); return { state: 'skipped', reason: 'no IG Story id' }; }
    if (!['photo', 'video'].includes(kind)) return { state: 'skipped', reason: `unknown kind ${kind}` };
    const done = storyBlocked(readStoryLedger(file), igStoryId);
    if (done) { log(`${tag}: already ${done.state} (${done.fbStoryId || 'no id'}) — not posted again`); return { state: 'skipped', reason: `already ${done.state}` }; }
    if (isMetaCdn(url)) {
      log(`${tag}: skipped — ${new URL(url).hostname} is a Meta CDN URL; only a re-hosted URL may be used`);
      return { state: 'skipped', reason: 'meta-cdn' };
    }
    let stage = '';
    const row = { date: istDay(now), igStoryId: String(igStoryId), igMediaId: String(igMediaId || ''), kind, source, at: new Date(now).toISOString() };
    try {
      const params = { pageId: env.FB_PAGE_ID, token: env.FB_PAGE_TOKEN, fetchImpl, onStage: (s) => { stage = s; } };
      const fbStoryId = kind === 'photo'
        ? await postPhotoStory({ ...params, imageUrl: url })
        : await postVideoStory({ ...params, videoUrl: url });
      writeStoryLedger(file, [...readStoryLedger(file), { ...row, state: 'done', fbStoryId }]);
      log(`${tag}: Facebook ${kind} story published ${fbStoryId}`);
      return { state: 'done', fbStoryId };
    } catch (err) {
      const uncertain = stage === 'publish' && !err.status && !err.details;
      const error = explainFbError(err);
      writeStoryLedger(file, [...readStoryLedger(file), { ...row, state: uncertain ? 'uncertain' : 'failed', stage, error }]);
      log(`${tag}: Facebook ${kind} story FAILED at ${stage || 'start'}${uncertain ? ' (uncertain — never retried)' : ''}: ${error}`);
      return { state: uncertain ? 'uncertain' : 'failed', error };
    }
  } catch (err) {
    log(`${tag}: Facebook story error (ignored): ${explainFbError(err)}`);
    return { state: 'failed', error: explainFbError(err) };
  }
}
