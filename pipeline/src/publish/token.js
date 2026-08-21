// Turn the short-lived token the Graph API Explorer hands you into one that
// survives past this afternoon.
//
// The Explorer's token expires in an hour or two. A daily poster on that token
// works once and then fails silently every morning after — so exchanging is not
// optional, it is the difference between a demo and a pipeline.

const VERSION = process.env.IG_API_VERSION || 'v23.0';
const GRAPH = 'https://graph.facebook.com';

async function graph(pathname, params) {
  const url = `${GRAPH}/${VERSION}/${pathname}?${new URLSearchParams(params)}`;
  const res = await fetch(url);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.error) {
    throw new Error(`${pathname} failed: ${payload.error?.message || res.status}`);
  }
  return payload;
}

/** Short-lived user token -> long-lived user token (about 60 days). */
export async function exchangeForLongLived({ token, appId, appSecret }) {
  const out = await graph('oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: token,
  });
  return { token: out.access_token, expiresIn: out.expires_in };
}

/**
 * Long-lived user token -> Page token. Page tokens derived from a long-lived user
 * token do not carry an expiry, which is what a daily scheduled job needs.
 */
export async function pageToken({ token, pageId }) {
  const { data } = await graph('me/accounts', { access_token: token, fields: 'id,name,access_token' });
  const page = data?.find((p) => String(p.id) === String(pageId));
  if (!page) {
    throw new Error(`Page ${pageId} not in this token's list: ${data?.map((p) => `${p.id} (${p.name})`).join(', ') || 'none'}`);
  }
  return { token: page.access_token, name: page.name };
}

/** How long is left on a token, and what it can do. */
export async function inspect({ token, appToken }) {
  const { data } = await graph('debug_token', { input_token: token, access_token: appToken || token });
  return {
    valid: data?.is_valid,
    expiresAt: data?.expires_at ? new Date(data.expires_at * 1000).toISOString() : 'never',
    scopes: data?.scopes || [],
    type: data?.type,
  };
}
