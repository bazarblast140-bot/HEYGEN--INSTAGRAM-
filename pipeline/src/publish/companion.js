// Reel companion: a Story and a Facebook Reel for every Paise Ki Pathshala Reel
// (marker pkp:video:<YouTube id>, video public on YouTube); never our own Reels.
//
// Paise Ki Pathshala (another repo) posts its YouTube Shorts to the same
// Instagram account as Reels. It posts no Story and nothing to Facebook. This
// job lists the account's recent media, and for each of those Reels:
//
//   * posts the same video as an Instagram Story (media_url first, then the
//     matching mp4 Paise hosted on this repo's releases), and
//   * copies it to the Facebook Page as a Reel (facebook.js), with the IG
//     caption plus one "link in bio" CTA when the caption has none.
//
// Never twice. Everything is keyed on the Instagram media id:
//   reel-companion-history.json   { igMediaId, story: {...}, fb: {...} }
//   fb-crosspost-history.json     consulted (and appended) so the own-Reel
//                                 cross-post and this job never both post one id
// The ledgers are re-read (and merged with origin) right before every post and
// committed right after it. A result whose response was lost after the final
// publish call is "uncertain" and is never retried automatically. A plain
// failure is retried on a later run, up to MAX_TRIES.
//
// Reels in reel-publish-history.json are this repo's own and are skipped: the
// own pipeline already handles their Story and Facebook copy.
//
// Nothing here throws past runCompanion: every failure is a logged line.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

import { isReelMedia } from './same-day.js';
import { ENGAGEMENT } from './caption.js';
import { withBioCta } from './cta.js';
import { flagOn } from './flags.js';
import { enabled as fbFlagOn, crossPostReel, istDay } from './facebook.js';
import { call, waitForContainer } from './instagram.js';
import { fbStory, FB_STORY_LEDGER, readStoryLedger, writeStoryLedger, mergeStoryLedger } from './fb-story.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COMPANION_LEDGER = path.resolve(HERE, '..', '..', 'reel-companion-history.json');
export const FB_LEDGER = path.resolve(HERE, '..', '..', 'fb-crosspost-history.json');
export const OWN_LEDGER = path.resolve(HERE, '..', '..', 'reel-publish-history.json');

export const ENABLE_REEL_COMPANION = 'ENABLE_REEL_COMPANION';
export const SOURCE = 'reel-companion';
export const WINDOW_HOURS = 36;
export const MAX_TRIES = 3;
export const RELEASE_MATCH_MINUTES = 90;
export const FB_CAPTION_LIMIT = 2200;
export const MEDIA_FIELDS = 'id,media_type,media_product_type,timestamp,permalink,media_url,caption';

const VERSION = process.env.IG_API_VERSION || 'v23.0';

// ---------------------------------------------------------------- redaction

export function redact(text, secrets = []) {
  let out = String(text ?? '').replace(/access_token=[^&\s"']+/gi, 'access_token=***');
  for (const s of secrets) if (s && s.length > 8) out = out.split(s).join('***');
  return out.slice(0, 400);
}

// ---------------------------------------------------------------- ledgers

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function readCompanion(file = COMPANION_LEDGER) {
  const parsed = readJson(file, {});
  return Array.isArray(parsed?.entries) ? parsed.entries : [];
}

export function writeCompanion(file, entries, keep = 300) {
  fs.writeFileSync(file, `${JSON.stringify({ entries: entries.slice(-keep) }, null, 2)}\n`);
}

export function readFbLedger(file = FB_LEDGER) {
  const parsed = readJson(file, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function readOwnIds(file = OWN_LEDGER) {
  const parsed = readJson(file, {});
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return new Set(entries.map((e) => String(e?.mediaId || '')).filter(Boolean));
}

const RANK = { done: 3, uncertain: 2, failed: 1 };

function strongerPart(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ra = RANK[a.state] || 0;
  const rb = RANK[b.state] || 0;
  if (ra !== rb) return ra > rb ? a : b;
  return (b.tries || 0) > (a.tries || 0) ? b : a;
}

/** Union of two companion ledgers. Per media id the stronger result wins: done > uncertain > failed. */
export function mergeCompanion(a = [], b = []) {
  const byId = new Map();
  for (const entry of [...a, ...b]) {
    const id = String(entry?.igMediaId || '');
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev) { byId.set(id, { ...entry }); continue; }
    byId.set(id, {
      ...prev,
      ...entry,
      story: strongerPart(prev.story, entry.story),
      fb: strongerPart(prev.fb, entry.fb),
    });
  }
  return [...byId.values()];
}

/** Union of two fb-crosspost ledgers, one row per Instagram media id. */
export function mergeFbLedger(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const row of [...a, ...b]) {
    const id = String(row?.igMediaId || '');
    const key = id || JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Re-read the ledger, set one part of one entry, write it back. */
export function updatePart(file, item, part, value) {
  const entries = readCompanion(file);
  const id = String(item.id);
  const existing = entries.find((e) => String(e.igMediaId) === id);
  const base = existing || {
    igMediaId: id,
    permalink: item.permalink || '',
    igTimestamp: item.timestamp || '',
    marker: markerOf(item.caption),
    story: null,
    fb: null,
  };
  // A done (or uncertain) result is never overwritten by a later failure; a
  // fresh attempt replaces an older failed record of the same part.
  const cur = base[part];
  const keep = cur && (cur.state === 'done' || (cur.state === 'uncertain' && value.state !== 'done'));
  const next = { ...base, [part]: keep ? cur : value };
  const rest = entries.filter((e) => String(e.igMediaId) !== id);
  writeCompanion(file, [...rest, next]);
  return next;
}

export function markerOf(caption) {
  const m = String(caption || '').match(/\bpkp:[A-Za-z0-9:._-]+/);
  return m ? m[0] : '';
}

/**
 * The Paise Ki Pathshala YouTube video id this Reel is for, or ''. Only a
 * Reel whose caption carries the marker pkp:video:<11-char id> is handled
 * (Paise writes it on every Reel). A caption that merely names Paise Ki
 * Pathshala or links a YouTube video is NOT enough (7 Oct audit: anyone's Reel
 * could say that). Anything else (our own Reels included) is never touched.
 */
export function paiseVideoId(caption) {
  const marker = String(caption || '').match(/\bpkp:video:([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
  return marker ? marker[1] : '';
}

// ---------------------------------------------------------------- Story length

// Instagram refuses Stories over 60 s (error 2207082). A longer video gets a
// sped-up copy for the Story only (the Facebook Reel keeps the original).
export const STORY_MAX_SECONDS = 59.5;
export const STORY_TARGET_SECONDS = 59;
export const MAX_SPEEDUP = 1.25;

/** none | speed (factor) | trim (to 59 s) for a video of this many seconds. */
export function storyPlan(duration) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return { action: 'unknown' };
  if (d <= STORY_MAX_SECONDS) return { action: 'none' };
  const factor = Math.ceil((d / STORY_TARGET_SECONDS) * 1000) / 1000;
  if (factor <= MAX_SPEEDUP) return { action: 'speed', factor };
  return { action: 'trim', seconds: STORY_TARGET_SECONDS };
}

/** ffmpeg arguments for that plan (audio only when the file has an audio stream). */
export function ffmpegArgs(plan, input, output, { hasAudio = true } = {}) {
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  const aenc = hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an'];
  if (plan.action === 'speed') {
    const f = plan.factor;
    const graph = hasAudio ? `[0:v]setpts=PTS/${f}[v];[0:a]atempo=${f}[a]` : `[0:v]setpts=PTS/${f}[v]`;
    return ['-y', '-i', input, '-filter_complex', graph, '-map', '[v]', ...(hasAudio ? ['-map', '[a]'] : []), ...enc, ...aenc, output];
  }
  if (plan.action === 'trim') return ['-y', '-i', input, '-t', String(plan.seconds), ...enc, ...aenc, output];
  throw new Error(`no ffmpeg step for "${plan.action}"`);
}

// ---------------------------------------------------------------- planning

function when(item) {
  const t = new Date(item?.timestamp || '').getTime();
  return Number.isNaN(t) ? null : t;
}

/** Why a Reel is this repo's own ('' when it is not). */
export function ownReason(item, { ownIds = new Set(), fbLedger = [] } = {}) {
  const id = String(item?.id || '');
  if (ownIds.has(id)) return 'in reel-publish-history.json';
  const fb = fbLedger.find((row) => String(row?.igMediaId) === id);
  if (fb && fb.source !== SOURCE) return 'already cross-posted by the own Reel pipeline';
  const caption = String(item?.caption || '');
  if (caption.includes(ENGAGEMENT) && !markerOf(caption)) return "caption carries this repo's own Reel CTA";
  return '';
}

/** todo | retry | done | uncertain | gave-up | off */
export function partState(entry, part, { fbLedger = [], id } = {}) {
  if (part === 'fb' && fbLedger.some((row) => String(row?.igMediaId) === String(id))) return 'done';
  const p = entry?.[part];
  if (!p) return 'todo';
  if (p.state === 'done') return 'done';
  if (p.state === 'uncertain') return 'uncertain';
  if ((p.tries || 0) >= MAX_TRIES) return 'gave-up';
  return 'retry';
}

export function planCompanion({
  media = [], now = Date.now(), ownIds = new Set(), companion = [], fbLedger = [],
  windowHours = WINDOW_HOURS, fbEnabled = false,
} = {}) {
  const since = now - windowHours * 3600 * 1000;
  const seen = new Set();
  return (media || [])
    .filter((item) => isReelMedia(item))
    .filter((item) => { const t = when(item); return t !== null && t >= since && t <= now + 10 * 60 * 1000; })
    .filter((item) => { const id = String(item.id); if (seen.has(id)) return false; seen.add(id); return true; })
    .sort((a, b) => when(a) - when(b))
    .map((item) => {
      const id = String(item.id);
      const own = ownReason(item, { ownIds, fbLedger });
      if (own) return { id, item, action: 'skip', reason: `own Reel (${own})`, story: 'own', fb: 'own', doStory: false, doFb: false };
      const yt = paiseVideoId(item.caption);
      if (!yt) return { id, item, action: 'skip', reason: 'not a Paise Ki Pathshala Reel (no pkp:video:<id> marker)', story: 'other', fb: 'other', doStory: false, doFb: false };
      const entry = companion.find((e) => String(e.igMediaId) === id);
      const story = partState(entry, 'story', { fbLedger, id });
      const fb = fbEnabled ? partState(entry, 'fb', { fbLedger, id }) : 'off';
      const doStory = story === 'todo' || story === 'retry';
      const doFb = fb === 'todo' || fb === 'retry';
      return {
        id, item, yt,
        action: doStory || doFb ? 'handle' : 'skip',
        reason: doStory || doFb ? '' : 'already handled',
        story, fb, doStory, doFb,
      };
    });
}

export function fbCaption(igCaption) {
  return withBioCta(igCaption, { limit: FB_CAPTION_LIMIT });
}

// ---------------------------------------------------------------- real API

async function companionRelease({ repo, token, create, fetchImpl = globalThis.fetch }) {
  if (!repo) return null;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'reel-companion', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/companion-media`, { headers, signal: AbortSignal.timeout(20000) });
  if (res.ok) return res.json();
  if (!create || !token) return null;
  const made = await fetchImpl(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: 'companion-media', name: 'companion-media', body: 'Video copies used by the Reel companion (Story + FB).', prerelease: true }),
    signal: AbortSignal.timeout(20000),
  });
  if (!made.ok) throw new Error(`release create ${made.status}`);
  return made.json();
}

export function realApi({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async listMedia({ igUserId, token, surface = 'facebook' }) {
      const host = surface === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
      const url = new URL(`${host}/${VERSION}/${encodeURIComponent(igUserId)}/media`);
      url.searchParams.set('fields', MEDIA_FIELDS);
      url.searchParams.set('limit', '25');
      url.searchParams.set('access_token', token);
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) return { ok: false, items: [], reason: `HTTP ${res.status} ${body.error?.message || ''}`.trim() };
        return { ok: true, items: Array.isArray(body.data) ? body.data : [], reason: 'ok' };
      } catch (err) {
        return { ok: false, items: [], reason: err.name || 'network' };
      }
    },

    /** True when the URL serves video bytes to an anonymous GET. */
    async probeVideo(url) {
      if (!/^https:\/\//.test(String(url || ''))) return false;
      try {
        const res = await fetchImpl(url, {
          headers: { Range: 'bytes=0-1023' }, redirect: 'follow', signal: AbortSignal.timeout(20000),
        });
        const type = String(res.headers?.get?.('content-type') || '');
        await res.body?.cancel?.().catch(() => {});
        return (res.status === 200 || res.status === 206) && /^(video\/|application\/octet-stream)/i.test(type);
      } catch {
        return false;
      }
    },

    /**
     * The mp4 Paise Ki Pathshala hosted on this repo's releases for this Reel:
     * tag ig-reel-<UTC date>, asset paise-short-*.mp4 uploaded shortly before
     * the Reel went live.
     */
    async releaseVideo({ repo, token, timestamp }) {
      const t = new Date(timestamp).getTime();
      if (!repo || Number.isNaN(t)) return '';
      const days = [0, -1].map((d) => new Date(t + d * 86400000).toISOString().slice(0, 10));
      const candidates = [];
      for (const day of [...new Set(days)]) {
        try {
          const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/ig-reel-${day}`, {
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': 'reel-companion',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: AbortSignal.timeout(20000),
          });
          if (!res.ok) continue;
          const release = await res.json();
          for (const asset of release.assets || []) {
            if (!/^paise-short-.*\.mp4$/i.test(String(asset.name || ''))) continue;
            const at = new Date(asset.created_at || asset.updated_at || '').getTime();
            if (Number.isNaN(at)) continue;
            // Paise uploads the mp4 minutes before the Reel goes live; its slots
            // are 5h+ apart, so 90 min cannot reach another slot's video.
            if (at > t + 10 * 60000 || at < t - RELEASE_MATCH_MINUTES * 60000) continue;
            candidates.push({ url: asset.browser_download_url, gap: Math.abs(t - at) });
          }
        } catch { /* try the next tag */ }
      }
      candidates.sort((a, b) => a.gap - b.gap);
      return candidates[0]?.url || '';
    },

    /** Video Story. onStage('publish') fires right before the final, non-retryable call. */
    /** A video pinned for one IG media id: release companion-media, asset ig-<id>.mp4. */
    async pinnedVideo({ repo, token, id }) {
      const rel = await companionRelease({ repo, token, create: false });
      const a = (rel?.assets || []).find((x) => x.name === `ig-${id}.mp4`);
      return a?.browser_download_url || '';
    },

    /** Download media_url in the runner and upload it to companion-media. */
    async rehostVideo({ repo, token, id, sourceUrl }) {
      if (!repo || !token) return '';
      const src = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(60000) });
      if (!src.ok) throw new Error(`media_url download ${src.status}`);
      const buf = Buffer.from(await src.arrayBuffer());
      if (buf.length < 10000) throw new Error('media_url download too small');
      const rel = await companionRelease({ repo, token, create: true });
      const name = `ig-${id}.mp4`;
      const have = (rel.assets || []).find((x) => x.name === name);
      if (have) return have.browser_download_url;
      const up = await fetchImpl(`https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${name}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4', Accept: 'application/vnd.github+json', 'User-Agent': 'reel-companion' },
        body: buf,
        signal: AbortSignal.timeout(120000),
      });
      if (!up.ok) throw new Error(`asset upload ${up.status}`);
      return (await up.json()).browser_download_url || '';
    },

    /** true = public/unlisted (oEmbed 200), false = private/removed (401/403/404), null = unknown. */
    async youtubePublic(videoId) {
      try {
        const res = await fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, { signal: AbortSignal.timeout(15000) });
        await res.body?.cancel?.().catch(() => {});
        if (res.status === 200) return true;
        if ([400, 401, 403, 404].includes(res.status)) return false;
        return null;
      } catch {
        return null;
      }
    },

    /**
     * The video to post as the Story: the original when it is ≤ 59.5 s, else a
     * copy sped up by duration/59 (≤ 1.25x) or trimmed to 59 s, uploaded once to
     * companion-media as ig-<id>-story.mp4 and reused from there afterwards.
     */
    async storyVideo({ repo, token, id, video, log = () => {} }) {
      const name = `ig-${id}-story.mp4`;
      const rel0 = await companionRelease({ repo, token, create: false }).catch(() => null);
      const pinned = (rel0?.assets || []).find((x) => x.name === name);
      if (pinned) return { url: pinned.browser_download_url, from: 'story-copy' };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-'));
      try {
        const input = path.join(dir, 'in.mp4');
        const src = await fetchImpl(video.url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
        if (!src.ok) throw new Error(`video download ${src.status}`);
        fs.writeFileSync(input, Buffer.from(await src.arrayBuffer()));
        const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], { encoding: 'utf8' }));
        const duration = Number(probe?.format?.duration);
        const hasAudio = (probe?.streams || []).some((st) => st.codec_type === 'audio');
        const plan = storyPlan(duration);
        if (plan.action === 'unknown') throw new Error('could not read the video duration');
        if (plan.action === 'none') return video;
        const output = path.join(dir, name);
        execFileSync('ffmpeg', ffmpegArgs(plan, input, output, { hasAudio }), { stdio: ['ignore', 'ignore', 'pipe'], timeout: 600000 });
        log(`  ${id}: video is ${duration.toFixed(1)} s — Story copy ${plan.action === 'speed' ? `sped up ${plan.factor}x` : `trimmed to ${plan.seconds} s`}`);
        if (!repo || !token) throw new Error('no repo token to host the Story copy');
        const rel = await companionRelease({ repo, token, create: true });
        const up = await fetchImpl(`https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${name}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4', Accept: 'application/vnd.github+json', 'User-Agent': 'reel-companion' },
          body: fs.readFileSync(output),
          signal: AbortSignal.timeout(120000),
        });
        if (!up.ok) throw new Error(`story copy upload ${up.status}`);
        return { url: (await up.json()).browser_download_url, from: `story-copy (${plan.action === 'speed' ? `${plan.factor}x` : 'trimmed 59 s'})` };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },

    async postStory({ igUserId, token, surface = 'facebook', videoUrl, onStage }) {
      onStage?.('container');
      const { id: containerId } = await call(`${igUserId}/media`, {
        method: 'POST', token, surface, params: { media_type: 'STORIES', video_url: videoUrl },
      });
      onStage?.('processing');
      await waitForContainer({ containerId, token, surface, pollMs: 4000, maxPolls: 45 });
      onStage?.('publish');
      const { id } = await call(`${igUserId}/media_publish`, {
        method: 'POST', token, surface, params: { creation_id: containerId },
      });
      return id;
    },

    async postFbReel({ pageId, token, videoUrl, caption, onStage }) {
      return crossPostReel({ pageId, token, videoUrl, caption, onStage, fetchImpl });
    },
  };
}

// ---------------------------------------------------------------- git sync

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Keep the ledgers in step with the branch: merge origin's copy in before a
 * post, and push right after it, with pull --rebase retries. The checkout is a
 * CI workspace, so a hard reset onto origin (followed by re-merging our rows)
 * is the fallback when a rebase conflicts.
 */
export function gitLedgerSync({ branch, files, log = () => {} }) {
  const rel = files.map((f) => path.relative(process.cwd(), f));

  function mergeFromOrigin() {
    git(['fetch', '-q', 'origin', branch]);
    for (const [i, file] of files.entries()) {
      let remote;
      try { remote = JSON.parse(git(['show', `origin/${branch}:${rel[i]}`])); } catch { continue; }
      if (file.endsWith('reel-companion-history.json')) {
        const merged = mergeCompanion(Array.isArray(remote?.entries) ? remote.entries : [], readCompanion(file));
        writeCompanion(file, merged);
      } else if (file.endsWith('fb-story-history.json') && Array.isArray(remote)) {
        writeStoryLedger(file, mergeStoryLedger(remote, readStoryLedger(file)));
      } else if (Array.isArray(remote)) {
        const merged = mergeFbLedger(remote, readFbLedger(file));
        fs.writeFileSync(file, `${JSON.stringify(merged.slice(-200), null, 2)}\n`);
      }
    }
  }

  return {
    async sync() {
      try { mergeFromOrigin(); } catch (err) { log(`  ledger sync with origin failed (local copy used): ${redact(err.message)}`); }
    },
    async commit(message) {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          git(['add', ...rel]);
          try { git(['diff', '--cached', '--quiet']); return true; } catch { /* staged changes */ }
          git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
            'commit', '-q', '-m', message]);
          try {
            git(['pull', '-q', '--rebase', '--autostash', 'origin', branch]);
          } catch {
            try { git(['rebase', '--abort']); } catch { /* nothing to abort */ }
            const ours = files.map((f) => fs.readFileSync(f, 'utf8'));
            git(['fetch', '-q', 'origin', branch]);
            git(['reset', '-q', '--hard', `origin/${branch}`]);
            files.forEach((f, i) => {
              const mine = JSON.parse(ours[i]);
              if (f.endsWith('reel-companion-history.json')) writeCompanion(f, mergeCompanion(readCompanion(f), mine.entries || []));
              else if (f.endsWith('fb-story-history.json')) writeStoryLedger(f, mergeStoryLedger(readStoryLedger(f), Array.isArray(mine) ? mine : []));
              else fs.writeFileSync(f, `${JSON.stringify(mergeFbLedger(readFbLedger(f), mine).slice(-200), null, 2)}\n`);
            });
            continue;
          }
          git(['push', '-q', 'origin', `HEAD:${branch}`]);
          return true;
        } catch (err) {
          log(`  ledger push attempt ${attempt} failed: ${redact(err.message)}`);
          await sleep(attempt * 3000);
        }
      }
      log('  COULD NOT PUSH the ledger — the local file still holds the result.');
      return false;
    },
  };
}

// ---------------------------------------------------------------- the run

function describe(p) {
  const t = p.item.timestamp || '?';
  const marker = markerOf(p.item.caption);
  const head = `${p.id}  ${t}${marker ? `  ${marker}` : ''}  ${p.item.permalink || ''}`.trim();
  if (p.action === 'skip') return `SKIP   ${head}  — ${p.reason}`;
  const parts = [
    p.doStory ? `Story (${p.story})` : `no Story (${p.story})`,
    p.doFb ? `FB Reel (${p.fb})` : `no FB (${p.fb})`,
  ];
  return `DO     ${head}  — ${parts.join(', ')}`;
}

export async function runCompanion({
  env = process.env,
  api = realApi(),
  now = Date.now(),
  dryRun = false,
  files = { companion: COMPANION_LEDGER, fb: FB_LEDGER, own: OWN_LEDGER, fbStory: FB_STORY_LEDGER },
  storyFetch = globalThis.fetch,
  sync = async () => {},
  commit = async () => true,
  log = (line) => console.log(line),
} = {}) {
  const result = { plan: [], stories: [], fb: [], fbStories: [], failures: [], skipped: false };
  const igUserId = env.IG_USER_ID;
  const token = env.IG_ACCESS_TOKEN;
  const surface = env.IG_SURFACE || 'facebook';
  const fbToken = env.FB_PAGE_TOKEN || env.IG_ACCESS_TOKEN;
  const pageId = env.FB_PAGE_ID;
  const secrets = [token, env.FB_PAGE_TOKEN, env.GITHUB_TOKEN].filter(Boolean);
  const say = (line) => log(redact(line, secrets));

  try {
    const on = flagOn(ENABLE_REEL_COMPANION, env);
    if (!on && !dryRun) {
      say('ENABLE_REEL_COMPANION is not true — Reel companion skipped, nothing posted.');
      result.skipped = true;
      return result;
    }
    if (!igUserId || !token) {
      say('Reel companion: IG_USER_ID or IG_ACCESS_TOKEN missing — nothing done.');
      result.skipped = true;
      return result;
    }
    const fbEnabled = fbFlagOn(env) && Boolean(pageId) && Boolean(fbToken);
    say(`Reel companion ${dryRun ? '(DRY RUN — nothing will be posted)' : ''}`.trim());
    say(`  window: last ${WINDOW_HOURS}h · Facebook: ${fbEnabled ? 'on' : 'off (FB_CROSSPOST not true or no Page)'} · flag ENABLE_REEL_COMPANION=${on ? 'true' : 'off'}`);

    const listed = await api.listMedia({ igUserId, token, surface });
    if (!listed.ok) {
      say(`  could not list Instagram media (${listed.reason}) — nothing done.`);
      return result;
    }

    const read = () => ({
      companion: readCompanion(files.companion),
      fbLedger: readFbLedger(files.fb),
      ownIds: readOwnIds(files.own),
    });
    const plan = planCompanion({ media: listed.items, now, fbEnabled, ...read() });
    result.plan = plan.map(({ item, ...rest }) => ({ ...rest, timestamp: item.timestamp, permalink: item.permalink || '', marker: markerOf(item.caption) }));
    const reels = plan.length;
    say(`  ${reels} Reel(s) on the account in the window`);
    for (const p of plan) say(`  ${describe(p)}`);
    if (!plan.some((p) => p.action === 'handle')) say('  nothing to do.');
    if (dryRun) return result;

    for (const p of plan.filter((x) => x.action === 'handle')) {
      if (api.youtubePublic) {
        const pub = await api.youtubePublic(p.yt);
        if (pub === false) {
          say(`  ${p.id}: YouTube video ${p.yt} is not public (oEmbed refused) — skipped, nothing posted.`);
          continue;
        }
      }
      let video = null;
      const resolveVideo = async () => {
        if (video) return video;
        // Meta refuses its own CDN URLs ("First-party Meta-hosted URLs are not
        // permitted"), so never hand media_url to Graph directly. Order:
        // 1) companion-media/ig-<id>.mp4 on this repo (pinned for this media id),
        // 2) re-host THIS Reel's media_url bytes onto companion-media,
        // 3) only then Paise's release mp4, matched by upload time — the one
        //    source that could be a different Paise video, so it is last
        //    (7 Oct audit: never post another video as this Reel's copy).
        const repo = env.GITHUB_REPOSITORY;
        const token = env.GITHUB_TOKEN;
        const pinned = api.pinnedVideo ? await api.pinnedVideo({ repo, token, id: p.item.id }).catch(() => '') : '';
        if (pinned && await api.probeVideo(pinned)) video = { url: pinned, from: 'pinned' };
        if (!video && p.item.media_url && api.rehostVideo) {
          const url = await api.rehostVideo({ repo, token, id: p.item.id, sourceUrl: p.item.media_url }).catch((e) => { say(`  ${p.item.id}: re-host failed: ${String(e?.message || e).slice(0, 160)}`); return ''; });
          if (url && await api.probeVideo(url)) video = { url, from: 'rehost' };
        }
        if (!video) {
          const url = await api.releaseVideo({
            repo: env.PAISE_MEDIA_REPO || repo,
            token,
            timestamp: p.item.timestamp,
          }).catch(() => '');
          if (url && await api.probeVideo(url)) video = { url, from: 'release' };
        }
        return video;
      };

      // --- Story
      if (p.doStory) {
        await sync();
        const fresh = planCompanion({ media: [p.item], now, fbEnabled, ...read() })[0];
        if (!fresh?.doStory) {
          say(`  ${p.id}: Story already recorded by another run — skipped.`);
        } else {
          const prev = readCompanion(files.companion).find((e) => String(e.igMediaId) === p.id)?.story;
          const tries = (prev?.tries || 0) + 1;
          let stage = '';
          try {
            const original = await resolveVideo();
            if (!original) throw new Error('no fetchable video (media_url and release mp4 both unavailable)');
            // Stories max out at 60 s: a longer video gets a sped-up / trimmed copy (Story only).
            const v = api.storyVideo
              ? await api.storyVideo({ repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, id: p.item.id, video: original, log: say })
              : original;
            const id = await api.postStory({ igUserId, token, surface, videoUrl: v.url, onStage: (s) => { stage = s; } });
            updatePart(files.companion, p.item, 'story', { state: 'done', id: String(id), from: v.from, tries, at: new Date(now).toISOString() });
            result.stories.push({ igMediaId: p.id, storyId: String(id), from: v.from });
            say(`  ${p.id}: Story published ${id} (video from ${v.from})`);
            // The same Story on the Facebook Page (video story, re-hosted URL).
            // Its own try: a failure is a logged line and can never mark the
            // IG Story failed or stop the Facebook Reel below.
            try {
              const fbs = await fbStory({
                kind: 'video', igStoryId: String(id), igMediaId: p.id, url: v.url, source: SOURCE, env,
                file: files.fbStory || FB_STORY_LEDGER, fetchImpl: storyFetch, now, log: (l) => say(`  ${p.id}: ${l}`),
              });
              result.fbStories.push({ igMediaId: p.id, igStoryId: String(id), ...fbs });
            } catch (e) {
              say(`  ${p.id}: Facebook Story error (ignored): ${redact(e?.message, secrets)}`);
            }
            await commit(`Record reel companion Story for ${p.id}`);
          } catch (err) {
            const uncertain = stage === 'publish' && !err.status;
            updatePart(files.companion, p.item, 'story', {
              state: uncertain ? 'uncertain' : 'failed', tries, stage, error: redact(err.message, secrets), at: new Date(now).toISOString(),
            });
            result.failures.push({ igMediaId: p.id, part: 'story', uncertain, error: redact(err.message, secrets) });
            say(`  ${p.id}: Story FAILED${uncertain ? ' (uncertain — will not retry)' : ` (try ${tries}/${MAX_TRIES})`}: ${err.message}`);
            await commit(`Record reel companion Story failure for ${p.id}`);
          }
        }
      }

      // --- Facebook
      if (p.doFb) {
        await sync();
        const fresh = planCompanion({ media: [p.item], now, fbEnabled, ...read() })[0];
        if (!fresh?.doFb) {
          say(`  ${p.id}: Facebook copy already recorded — skipped.`);
        } else {
          const prev = readCompanion(files.companion).find((e) => String(e.igMediaId) === p.id)?.fb;
          const tries = (prev?.tries || 0) + 1;
          let stage = '';
          try {
            const v = await resolveVideo();
            if (!v) throw new Error('no fetchable video (media_url and release mp4 both unavailable)');
            const out = await api.postFbReel({
              pageId, token: fbToken, videoUrl: v.url, caption: fbCaption(p.item.caption), onStage: (s) => { stage = s; },
            });
            updatePart(files.companion, p.item, 'fb', { state: 'done', id: String(out.id), url: out.url, from: v.from, tries, at: new Date(now).toISOString() });
            const fbRows = readFbLedger(files.fb);
            fbRows.push({ date: istDay(new Date(now)), kind: 'reel', igMediaId: p.id, fbId: String(out.id), source: SOURCE });
            fs.writeFileSync(files.fb, `${JSON.stringify(fbRows.slice(-200), null, 2)}\n`);
            result.fb.push({ igMediaId: p.id, fbId: String(out.id), url: out.url });
            say(`  ${p.id}: Facebook Reel published ${out.id} ${out.url}`);
            await commit(`Record reel companion Facebook copy for ${p.id}`);
          } catch (err) {
            const uncertain = stage === 'finish' && !err.status;
            updatePart(files.companion, p.item, 'fb', {
              state: uncertain ? 'uncertain' : 'failed', tries, stage, error: redact(err.message, secrets), at: new Date(now).toISOString(),
            });
            result.failures.push({ igMediaId: p.id, part: 'fb', uncertain, error: redact(err.message, secrets) });
            say(`  ${p.id}: Facebook FAILED${uncertain ? ' (uncertain — will not retry)' : ` (try ${tries}/${MAX_TRIES})`}: ${err.message}`);
            await commit(`Record reel companion Facebook failure for ${p.id}`);
          }
        }
      }
    }
  } catch (err) {
    say(`Reel companion error (soft-fail, nothing else attempted): ${err.message}`);
    result.failures.push({ part: 'run', error: redact(err.message, secrets) });
  }
  return result;
}
