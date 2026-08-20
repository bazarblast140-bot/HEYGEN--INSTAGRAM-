// Publish a Reel through the Instagram API with Instagram Login.
//
// This is the Instagram-Login surface, NOT the Facebook-Page one:
//   host        graph.instagram.com        (not graph.facebook.com)
//   token       Instagram user token       (not a Page token)
//   permissions instagram_business_basic, instagram_business_content_publish
//                                          (not instagram_basic / instagram_content_publish)
// No Facebook Page is involved anywhere.
//
// UNVERIFIED: docs are unreachable from the build environment, so the host, API
// version and field names below are inferred. All three are overridable by env so
// a mismatch is a config change, not a code change, and every failure prints the
// exact URL it called.

const HOST = process.env.IG_API_HOST || 'https://graph.instagram.com';
const VERSION = process.env.IG_API_VERSION || 'v23.0';

// Instagram pulls the file from a URL — it never accepts an upload — so the video
// must already be reachable, publicly, over HTTPS before any of this runs.
async function call(pathname, { method = 'GET', params = {}, token }) {
  const url = new URL(`${HOST}/${VERSION}/${pathname}`);
  const body = new URLSearchParams({ ...params, access_token: token });

  const res = await fetch(method === 'GET' ? `${url}?${body}` : url, {
    method,
    ...(method === 'GET' ? {} : { body }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.error) {
    const e = payload.error || {};
    throw Object.assign(
      new Error(`Instagram ${method} ${url.pathname} failed: ${e.message || res.status}${e.code ? ` (code ${e.code})` : ''}`),
      { status: res.status, details: payload },
    );
  }
  return payload;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Step 1 — hand Instagram the video URL and get a container back. */
export async function createReelContainer({ igUserId, videoUrl, caption, token, shareToFeed = true, coverUrl }) {
  if (!/^https:\/\//.test(videoUrl)) {
    throw new Error(`videoUrl must be a public https URL that Instagram can fetch; got "${videoUrl}"`);
  }

  const { id } = await call(`${igUserId}/media`, {
    method: 'POST',
    token,
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
export async function waitForContainer({ containerId, token, pollMs = 5000, maxPolls = 60, onStatus }) {
  for (let i = 0; i < maxPolls; i += 1) {
    const { status_code: code, status } = await call(containerId, {
      token, params: { fields: 'status_code,status' },
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
export async function publishContainer({ igUserId, containerId, token }) {
  const { id } = await call(`${igUserId}/media_publish`, {
    method: 'POST', token, params: { creation_id: containerId },
  });
  return id;
}

export async function publishReel({
  igUserId = process.env.IG_USER_ID,
  token = process.env.IG_ACCESS_TOKEN,
  videoUrl,
  caption,
  shareToFeed,
  coverUrl,
  onStatus,
}) {
  if (!igUserId) throw new Error('No IG_USER_ID. Set it in .env or pass igUserId.');
  if (!token) throw new Error('No IG_ACCESS_TOKEN. Set it in .env or pass token.');

  const containerId = await createReelContainer({ igUserId, videoUrl, caption, token, shareToFeed, coverUrl });
  onStatus?.('container', containerId);

  await waitForContainer({ containerId, token, onStatus: (code) => onStatus?.('processing', code) });

  const mediaId = await publishContainer({ igUserId, containerId, token });
  onStatus?.('published', mediaId);

  return { mediaId, containerId };
}

/** Confirm the token works and points at the account you expect, before spending a render on it. */
export async function whoami({ igUserId = process.env.IG_USER_ID, token = process.env.IG_ACCESS_TOKEN } = {}) {
  return call(igUserId || 'me', { token, params: { fields: 'id,username,account_type,media_count' } });
}
