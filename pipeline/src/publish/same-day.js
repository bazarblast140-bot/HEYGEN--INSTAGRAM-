// Same-day publish guards.
//
// A Reel is "already out today" only when Instagram accepted it: a media id
// written after publish, or a Reel on the account's media list dated today
// (IST). The topic ledger is not that signal. Run 36965276637 recorded
// "NIFTYBEES false breakdown wick" and then hosting failed, so the topic was
// on the branch and nothing was on the feed. A topic check would skip the
// retry that still has to post.
//
// Carousel posts keep their own ledger (`YYYY-MM-DD <slot>`), which is
// committed only after publish. Instagram media is the backup when that
// commit did not land.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { istParts, WINDOWS, ALL_SLOTS } from '../carousel/categories.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REEL_PUBLISH_LEDGER = path.resolve(HERE, '..', '..', 'reel-publish-history.json');

export function clock(env = process.env) {
  const raw = env.SLOT_NOW;
  if (!raw) return new Date();
  const when = new Date(raw);
  return Number.isNaN(when.getTime()) ? new Date() : when;
}

export function istDate(now = new Date()) {
  return istParts(now).date;
}

export function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

export function isReelMedia(item) {
  const product = String(item?.media_product_type || '').toUpperCase();
  const type = String(item?.media_type || '').toUpperCase();
  return product === 'REELS' || type === 'REELS';
}

export function isCarouselMedia(item) {
  const type = String(item?.media_type || '').toUpperCase();
  const product = String(item?.media_product_type || '').toUpperCase();
  return type === 'CAROUSEL_ALBUM' || type === 'CAROUSEL' || product === 'CAROUSEL';
}

function onIstDay(item, date) {
  if (!item?.timestamp) return false;
  const when = new Date(item.timestamp);
  if (Number.isNaN(when.getTime())) return false;
  return istDate(when) === date;
}

export async function readReelPublishes(file = REEL_PUBLISH_LEDGER) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/**
 * Whether today's Reel already published.
 *
 * `publishEntries` are `{ date, mediaId }` rows written after Instagram
 * returns an id. Topic-history rows are not consulted. `force` is the
 * explicit override for a second post.
 */
export function resolveReelPublish({
  now = new Date(),
  publishEntries = [],
  media = [],
  force = false,
} = {}) {
  const date = istDate(now);
  if (force) return { date, pending: true, reason: 'forced', posted: null, via: 'force' };

  const posted = (publishEntries || []).find((entry) => {
    const id = String(entry?.mediaId || '');
    return String(entry?.date || '').slice(0, 10) === date && /^\d{6,}$/.test(id);
  }) || null;
  if (posted) return { date, pending: false, reason: 'duplicate', posted, via: 'ledger' };

  const ig = (media || []).find((item) => isReelMedia(item) && onIstDay(item, date)) || null;
  if (ig) {
    return {
      date,
      pending: false,
      reason: 'duplicate',
      posted: { date, mediaId: String(ig.id || ''), topic: '' },
      via: 'instagram',
    };
  }

  return { date, pending: true, reason: 'due', posted: null, via: '' };
}

// A post goes up a few minutes after its run started, so a carousel counts
// toward a slot up to this long after the slot's window closes. Matches the
// post gate's grace (approve-build.js POST_GRACE_MINUTES): a run may publish
// at most 20 min after it started inside its window.
export const ATTRIBUTION_GRACE_MINUTES = 20;

function minutesIst(item) {
  const when = new Date(item?.timestamp);
  return Number.isNaN(when.getTime()) ? null : istParts(when).minutes;
}

function attributable(slot, item) {
  const w = WINDOWS[slot];
  const m = minutesIst(item);
  return Boolean(w) && m !== null && m >= w.start && m < w.end + ATTRIBUTION_GRACE_MINUTES;
}

/**
 * Which slots already have a carousel today (IST), decided per slot.
 *
 * 1. Ledger (pipeline/carousel-history.json, committed only after publish):
 *    an entry `YYYY-MM-DD <slot>` means that slot posted. Its `mediaId`, when
 *    recorded, claims that Instagram post for that slot.
 * 2. Facebook copy ledger (fb-crosspost-history.json): a carousel row with a
 *    `slot` and `igMediaId` claims that post for that slot too (it is committed
 *    by a separate step, so it covers a lost topic commit).
 * 3. Instagram media list: a carousel from today that no ledger row claims
 *    (a publish whose ledger commit did not land) counts for the slot whose
 *    window (+grace) holds its time. Inside the ai/midday overlap it is
 *    ambiguous and counts for EVERY open candidate slot — fail closed: a slot
 *    may be skipped, never posted twice.
 *    Ledger entries without a mediaId (older rows) claim the first unclaimed
 *    post in their own window, so an old row and its post are not counted twice.
 *
 * Returns { [slot]: { via: 'ledger'|'fb-ledger'|'instagram', mediaId, ambiguous? } }.
 */
export function postedSlots({ media = [], entries = [], fbEntries = [], now = new Date(), slots = ALL_SLOTS } = {}) {
  const date = istDate(now);
  const out = {};
  const claimed = new Set();
  const legacy = [];
  for (const e of entries || []) {
    const [day, slot] = String(e?.date || '').split(' ');
    if (day !== date || !slots.includes(slot)) continue;
    out[slot] = { via: 'ledger', mediaId: e.mediaId ? String(e.mediaId) : '' };
    if (e.mediaId) claimed.add(String(e.mediaId)); else legacy.push(slot);
  }
  for (const f of fbEntries || []) {
    if (String(f?.date || '').slice(0, 10) !== date || f?.kind !== 'carousel' || !slots.includes(f?.slot)) continue;
    if (f.igMediaId) claimed.add(String(f.igMediaId));
    if (!out[f.slot]) out[f.slot] = { via: 'fb-ledger', mediaId: String(f.igMediaId || '') };
  }
  let unclaimed = (media || []).filter((item) => isCarouselMedia(item) && onIstDay(item, date) && !claimed.has(String(item.id || '')))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  for (const slot of legacy) {
    const i = unclaimed.findIndex((item) => attributable(slot, item));
    if (i >= 0) unclaimed = unclaimed.filter((_, k) => k !== i);
  }
  for (const item of unclaimed) {
    const candidates = slots.filter((slot) => !out[slot] && attributable(slot, item));
    for (const slot of candidates) {
      out[slot] = { via: 'instagram', mediaId: String(item.id || ''), ...(candidates.length > 1 ? { ambiguous: true } : {}) };
    }
  }
  return out;
}

/**
 * The Instagram/ledger evidence that `slot` already posted today, or null.
 * Slot-aware: another slot's recorded post never counts for this one.
 */
export function carouselOnInstagram({ media = [], slot, now = new Date(), entries = [], fbEntries = [] } = {}) {
  if (!slot) return null;
  const hit = postedSlots({ media, entries, fbEntries, now })[slot];
  if (!hit || hit.via !== 'instagram') return null;
  return (media || []).find((item) => String(item.id || '') === hit.mediaId) || { id: hit.mediaId };
}

/**
 * Recent media for the connected Instagram account.
 * A missing token or a failed call returns no items and does not throw —
 * the ledger still decides, and a skip must not become a failed job.
 * The access token is never included in the returned reason.
 */
export async function listRecentMedia({
  igUserId,
  token,
  surface = 'facebook',
  fetcher = globalThis.fetch,
} = {}) {
  if (!igUserId || !token) return { items: [], ok: false, reason: 'no-token' };
  const host = surface === 'instagram'
    ? 'https://graph.instagram.com'
    : 'https://graph.facebook.com';
  const url = new URL(`${host}/v23.0/${encodeURIComponent(igUserId)}/media`);
  url.searchParams.set('fields', 'id,media_type,media_product_type,timestamp');
  url.searchParams.set('limit', '25');
  url.searchParams.set('access_token', token);
  try {
    const res = await fetcher(url, { method: 'GET' });
    if (!res?.ok) return { items: [], ok: false, reason: 'http' };
    const body = await res.json();
    const items = Array.isArray(body?.data) ? body.data : [];
    return { items, ok: true, reason: 'ok' };
  } catch {
    return { items: [], ok: false, reason: 'network' };
  }
}

export async function loadReelMedia({ env = process.env, fetcher } = {}) {
  return listRecentMedia({
    igUserId: env.IG_USER_ID,
    token: env.IG_ACCESS_TOKEN,
    surface: env.IG_SURFACE || 'facebook',
    fetcher,
  });
}

export async function decideReelDay({
  now = new Date(),
  publishEntries,
  media,
  force = false,
  env = process.env,
  publishFile = env.REEL_PUBLISH_FILE || REEL_PUBLISH_LEDGER,
  fetcher,
} = {}) {
  const entries = publishEntries || await readReelPublishes(publishFile);
  let items = media;
  let listed = { ok: Boolean(media), reason: media ? 'given' : 'not-checked' };
  if (!items && !force) {
    listed = await loadReelMedia({ env, fetcher });
    items = listed.items;
  }
  return {
    ...resolveReelPublish({ now, publishEntries: entries, media: items || [], force }),
    listed: { ok: listed.ok, reason: listed.reason },
  };
}

/**
 * The own Reel is the evening FALLBACK: it goes out only when no Reel at all
 * (Paise Ki Pathshala's or ours) is on the account today (IST). This runs
 * before DeepSeek, ElevenLabs and every other paid step.
 *
 * Fail closed: when the Instagram media list cannot be read (after one retry),
 * there is no way to know whether today already has a Reel, so the run is a
 * soft skip rather than a possible second Reel. force=true still builds.
 */
export async function decideFallbackReel({
  now = new Date(),
  force = false,
  env = process.env,
  fetcher,
  publishFile,
  retryMs = 5000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let decision = await decideReelDay({ now, force, env, fetcher, ...(publishFile ? { publishFile } : {}) });
  if (!decision.pending || force) return decision;
  if (!decision.listed?.ok) {
    await sleep(retryMs);
    decision = await decideReelDay({ now, force, env, fetcher, ...(publishFile ? { publishFile } : {}) });
    if (decision.pending && !decision.listed?.ok) {
      return { ...decision, pending: false, reason: 'unverified', via: `instagram media list unavailable (${decision.listed?.reason || 'unknown'})` };
    }
  }
  return decision;
}
