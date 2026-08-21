// Publish a Reel to Instagram.
//
// Instagram exposes two different publishing surfaces and they are not
// interchangeable — same three-step flow, different host, token and account id:
//
//   facebook   graph.facebook.com    Page token       instagram_basic,
//                                                     instagram_content_publish
//                                                     account id looks like 17841…
//
//   instagram  graph.instagram.com   IG user token    instagram_business_basic,
//                                                     instagram_business_content_publish
//                                                     no Facebook Page involved
//
// Which one an account is set up for is a fact about the account, not a
// preference, so rather than guessing, `whoami` probes both and reports which
// actually answers. Set IG_SURFACE to pin it once you know.
//
// UNVERIFIED: the docs are unreachable from this environment, so API version and
// field names are inferred. Host and version are env-overridable and every
// failure prints the exact URL it called, so a mismatch is a config change.

import { env } from '../../../src/config.js';

const SURFACES = {
  facebook:  'https://graph.facebook.com',
  instagram: 'https://graph.instagram.com',
};

const DEFAULT_SURFACE = env('IG_SURFACE') || 'facebook';
const VERSION = env('IG_API_VERSION') || 'v23.0';

function hostFor(surface) {
  if (env('IG_API_HOST')) return env('IG_API_HOST');
  const host = SURFACES[surface];
  if (!host) throw new Error(`Unknown surface "${surface}". Use one of: ${Object.keys(SURFACES).join(', ')}`);
  return host;
}

// Instagram pulls the file from a URL — it never accepts an upload — so the video
// must already be reachable, publicly, over HTTPS before any of this runs.
async function call(pathname, { method = 'GET', params = {}, token, surface = DEFAULT_SURFACE }) {
  const url = new URL(`${hostFor(surface)}/${VERSION}/${pathname}`);
  const body = new URLSearchParams({ ...params, access_token: token });

  const res = await fetch(method === 'GET' ? `${url}?${body}` : url, {
    method,
    ...(method === 'GET' ? {} : { body }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.error) {
    const e = payload.error || {};
    throw Object.assign(
      new Error(`Instagram ${method} ${url.host}${url.pathname} failed: ${e.message || res.status}${e.code ? ` (code ${e.code})` : ''}`),
      { status: res.status, details: payload },
    );
  }
  return payload;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Step 1 — hand Instagram the video URL and get a container back. */
export async function createReelContainer({ igUserId, videoUrl, caption, token, shareToFeed = true, coverUrl, surface }) {
  if (!/^https:\/\//.test(videoUrl)) {
    throw new Error(`videoUrl must be a public https URL that Instagram can fetch; got "${videoUrl}"`);
  }

  const { id } = await call(`${igUserId}/media`, {
    method: 'POST',
    token, surface,
    params: {
      media_type: 'REELS',
      video_url: videoUrl,
      share_to_feed: String(shareToFeed),
      ...(caption ? { caption } : {}),
      ...(coverUrl ? { cover_url: coverUrl } : {}),
    },
  });
  return id;
}

/**
 * Step 2 — wait for Instagram to finish downloading and transcoding.
 * Publishing before FINISHED fails, so this is not optional.
 */
export async function waitForContainer({ containerId, token, surface, pollMs = 5000, maxPolls = 60, onStatus }) {
  for (let i = 0; i < maxPolls; i += 1) {
    const { status_code: code, status } = await call(containerId, {
      token, surface, params: { fields: 'status_code,status' },
    });
    onStatus?.(code, status);

    if (code === 'FINISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error(`Instagram rejected the video (${code}): ${status || 'no detail given'}`);
    }
    await sleep(pollMs);
  }
  throw new Error(`Container ${containerId} still processing after ${Math.round((pollMs * maxPolls) / 1000)}s`);
}

/** Step 3 — publish the finished container. */
export async function publishContainer({ igUserId, containerId, token, surface }) {
  const { id } = await call(`${igUserId}/media_publish`, {
    method: 'POST', token, surface, params: { creation_id: containerId },
  });
  return id;
}

export async function publishReel({
  igUserId = env('IG_USER_ID'),
  token = env('IG_ACCESS_TOKEN'),
  videoUrl,
  caption,
  shareToFeed,
  coverUrl,
  surface = DEFAULT_SURFACE,
  onStatus,
}) {
  if (!igUserId) throw new Error('No IG_USER_ID. Set it in .env or pass igUserId.');
  if (!token) throw new Error('No IG_ACCESS_TOKEN. Set it in .env or pass token.');

  const containerId = await createReelContainer({ igUserId, videoUrl, caption, token, shareToFeed, coverUrl, surface });
  onStatus?.('container', containerId);

  await waitForContainer({ containerId, token, surface, onStatus: (code) => onStatus?.('processing', code) });

  const mediaId = await publishContainer({ igUserId, containerId, token, surface });
  onStatus?.('published', mediaId);

  return { mediaId, containerId };
}

/**
 * Try both surfaces and report which one this token and account actually work on.
 * Run it before spending a render — an hour of build is wasted on a token that was
 * never going to publish.
 */
export async function whoami({ igUserId = env('IG_USER_ID'), token = env('IG_ACCESS_TOKEN') } = {}) {
  if (!token) throw new Error('No IG_ACCESS_TOKEN. Set it in .env or pass token.');

  const results = [];
  for (const surface of Object.keys(SURFACES)) {
    try {
      const account = await call(igUserId || 'me', {
        token, surface, params: { fields: 'id,username,account_type,media_count' },
      });
      results.push({ surface, ok: true, account });
    } catch (err) {
      results.push({ surface, ok: false, error: err.message });
    }
  }

  const working = results.find((r) => r.ok);
  return { working: working?.surface || null, results };
}
