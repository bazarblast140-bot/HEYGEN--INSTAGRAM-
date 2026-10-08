// Read-only performance report for the Instagram account and its Facebook Page.
//
// Every request here is a GET. Nothing is created, edited or published. A metric
// the token may not read is reported with Graph's own error, never guessed: the
// report keeps the public counts the media node carries (like_count,
// comments_count) and marks everything else "n/a".

const VERSION = process.env.IG_API_VERSION || 'v23.0';
const GRAPH = 'https://graph.facebook.com';

// Requested per post. Unsupported ones (code 100) are retried one at a time.
export const IG_METRICS = ['reach', 'likes', 'comments', 'saved', 'shares', 'follows', 'profile_visits', 'views', 'total_interactions'];
export const FB_FIELDSETS = [
  'id,created_time,message,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)',
  'id,created_time,message,permalink_url,shares,reactions.summary(total_count).limit(0)',
  'id,created_time,message,permalink_url,shares',
];
export const FB_POST_METRICS = ['post_impressions_unique', 'post_clicks', 'post_reactions_by_type_total'];

const PERMISSION_CODES = new Set([10, 190, 200, 3]);

/** GET only. Throws an Error carrying {status, code, details} on a Graph error. */
export async function get(pathname, { params = {}, token, fetchImpl = fetch } = {}) {
  const url = pathname.startsWith('https://') ? new URL(pathname) : new URL(`${GRAPH}/${VERSION}/${pathname}`);
  if (!pathname.startsWith('https://')) {
    for (const [k, v] of Object.entries({ ...params, access_token: token })) url.searchParams.set(k, v);
  }
  const res = await fetchImpl(String(url), { method: 'GET' });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.error) {
    const e = payload.error || {};
    throw Object.assign(new Error(`${e.message || `HTTP ${res.status}`}`), {
      status: res.status, code: e.code, subcode: e.error_subcode, type: e.type, fbtrace: e.fbtrace_id, details: payload,
    });
  }
  return payload;
}

/** "message · code N/subcode · type · HTTP s" — the exact Graph error, never the token. */
export function graphError(err) {
  const bits = [String(err?.message || err).replace(/access_token=[^&\s]+/g, 'access_token=***')];
  if (err?.code != null) bits.push(`code ${err.code}${err.subcode ? `/${err.subcode}` : ''}`);
  if (err?.type) bits.push(err.type);
  if (err?.status) bits.push(`HTTP ${err.status}`);
  return bits.join(' · ');
}

export const isPermissionError = (err) => PERMISSION_CODES.has(Number(err?.code))
  || /permission|instagram_manage_insights|read_insights/i.test(String(err?.message || ''));

const valueOf = (d) => {
  const v = d?.total_value?.value ?? d?.values?.[0]?.value;
  return v != null && typeof v === 'object' ? Object.values(v).reduce((a, b) => a + (Number(b) || 0), 0) : v;
};

/** Insights for one IG media. Returns {metrics, errors}; never throws. */
export async function mediaInsights(id, { token, fetchImpl, metrics = IG_METRICS }) {
  const out = {};
  const errors = {};
  try {
    const res = await get(`${id}/insights`, { params: { metric: metrics.join(',') }, token, fetchImpl });
    for (const d of res.data || []) out[d.name] = valueOf(d);
    return { metrics: out, errors };
  } catch (err) {
    if (isPermissionError(err) || metrics.length === 1) {
      for (const m of metrics) errors[m] = graphError(err);
      return { metrics: out, errors, permission: isPermissionError(err) ? graphError(err) : undefined };
    }
  }
  // Some metric in the set is not supported for this media type: ask one by one.
  for (const m of metrics) {
    try {
      const res = await get(`${id}/insights`, { params: { metric: m }, token, fetchImpl });
      const d = (res.data || [])[0];
      if (d) out[m] = valueOf(d);
    } catch (err) {
      errors[m] = graphError(err);
      if (isPermissionError(err)) return { metrics: out, errors, permission: graphError(err) };
    }
  }
  return { metrics: out, errors };
}

/** Which scopes a token carries (debug_token with itself). Never throws. */
export async function scopesOf(token, fetchImpl) {
  try {
    const { data } = await get('debug_token', { params: { input_token: token }, token, fetchImpl });
    return { type: data?.type, scopes: data?.scopes || [], valid: data?.is_valid, expires: data?.expires_at };
  } catch (err) {
    return { error: graphError(err) };
  }
}

/** IG media since `sinceMs`, newest first (follows paging). */
export async function listMedia({ igUserId, token, fetchImpl, sinceMs }) {
  const fields = 'id,caption,timestamp,media_type,media_product_type,permalink,like_count,comments_count';
  let page = await get(`${igUserId}/media`, { params: { fields, limit: '50' }, token, fetchImpl });
  const rows = [];
  for (let guard = 0; guard < 10; guard += 1) {
    for (const m of page.data || []) {
      if (Date.parse(m.timestamp) < sinceMs) return rows;
      rows.push(m);
    }
    if (!page.paging?.next) break;
    page = await get(page.paging.next, { fetchImpl });
  }
  return rows;
}

export function istParts(iso) {
  const d = new Date(Date.parse(iso) + 330 * 60000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), hour: d.getUTCHours() };
}

/**
 * The whole report. Tries IG_ACCESS_TOKEN for insights; on a permission error
 * tries FB_PAGE_TOKEN once (same Page, may carry different grants). Never throws
 * for a metric; throws only if the media list itself cannot be read.
 */
export async function buildReport({ env = process.env, fetchImpl = fetch, now = Date.now(), days = 14 } = {}) {
  const igUserId = env.IG_USER_ID;
  const igToken = env.IG_ACCESS_TOKEN;
  const pageId = env.FB_PAGE_ID;
  const pageToken = env.FB_PAGE_TOKEN;
  const sinceMs = now - days * 86400000;
  const report = { generatedAt: new Date(now).toISOString(), days, tokens: {}, account: null, insightsSource: null, insightsError: null, ig: [], fb: { posts: [], error: null } };

  report.tokens.IG_ACCESS_TOKEN = igToken ? await scopesOf(igToken, fetchImpl) : { error: 'not set' };
  report.tokens.FB_PAGE_TOKEN = pageToken ? await scopesOf(pageToken, fetchImpl) : { error: 'not set' };

  try {
    report.account = await get(igUserId, { params: { fields: 'username,followers_count,follows_count,media_count' }, token: igToken, fetchImpl });
  } catch (err) { report.account = { error: graphError(err) }; }

  const media = await listMedia({ igUserId, token: igToken, fetchImpl, sinceMs });
  const candidates = [['IG_ACCESS_TOKEN', igToken], ['FB_PAGE_TOKEN', pageToken]].filter(([, t]) => t);
  let insightsToken = null;
  const permissionErrors = {};
  for (const m of media) {
    const row = {
      id: m.id, ...istParts(m.timestamp), type: m.media_product_type === 'REELS' ? 'REEL' : m.media_type,
      title: String(m.caption || '').split('\n')[0].slice(0, 70), permalink: m.permalink,
      like_count: m.like_count ?? null, comments_count: m.comments_count ?? null, metrics: {}, errors: {},
    };
    const tries = insightsToken ? [insightsToken] : (Object.keys(permissionErrors).length === candidates.length ? [] : candidates);
    for (const [name, token] of tries) {
      const r = await mediaInsights(m.id, { token, fetchImpl });
      if (r.permission) { permissionErrors[name] = r.permission; row.errors = r.errors; continue; }
      insightsToken = [name, token];
      row.metrics = r.metrics;
      row.errors = r.errors;
      break;
    }
    report.ig.push(row);
  }
  report.insightsSource = insightsToken ? insightsToken[0] : null;
  report.insightsError = insightsToken ? null : (Object.keys(permissionErrors).length ? permissionErrors : null);

  // Facebook Page posts: public counts plus whatever post insights the Page token may read.
  if (pageId && pageToken) {
    try {
      // Comments (and on some Pages reactions) are "user content": without
      // pages_read_user_content Graph refuses the whole list, so ask for less.
      let res = null;
      const refused = [];
      for (const fields of FB_FIELDSETS) {
        try {
          res = await get(`${pageId}/posts`, { params: { fields, since: String(Math.floor(sinceMs / 1000)), limit: '50' }, token: pageToken, fetchImpl });
          break;
        } catch (err) {
          refused.push(graphError(err));
          if (fields === FB_FIELDSETS[FB_FIELDSETS.length - 1]) throw err;
        }
      }
      if (refused.length) report.fb.fieldErrors = refused;
      for (const p of res.data || []) {
        const row = {
          id: p.id, ...istParts(p.created_time), title: String(p.message || '').split('\n')[0].slice(0, 70), permalink: p.permalink_url,
          reactions: p.reactions?.summary?.total_count ?? null, comments: p.comments?.summary?.total_count ?? null, shares: p.shares?.count ?? 0,
          metrics: {}, errors: {},
        };
        for (const metric of FB_POST_METRICS) {
          try {
            const r = await get(`${p.id}/insights`, { params: { metric }, token: pageToken, fetchImpl });
            const d = (r.data || [])[0];
            if (d) row.metrics[metric] = valueOf(d);
          } catch (err) { row.errors[metric] = graphError(err); }
        }
        report.fb.posts.push(row);
      }
    } catch (err) { report.fb.error = graphError(err); }
  } else {
    report.fb.error = 'FB_PAGE_ID or FB_PAGE_TOKEN not set';
  }
  return report;
}

const cell = (v) => (v == null ? 'n/a' : String(v));

/** Markdown for the step summary. */
export function toMarkdown(r) {
  const L = [];
  L.push(`## Performance — last ${r.days} days (generated ${r.generatedAt})`, '');
  if (r.account?.username) L.push(`@${r.account.username} · ${cell(r.account.followers_count)} followers · ${cell(r.account.media_count)} posts`, '');
  else if (r.account?.error) L.push(`Account read failed: ${r.account.error}`, '');
  for (const [name, t] of Object.entries(r.tokens)) {
    L.push(`- ${name}: ${t.error ? `scopes unknown (${t.error})` : `${t.type || '?'} token, scopes: ${t.scopes.join(', ') || 'none listed'}`}`);
  }
  L.push('');
  if (r.insightsSource) L.push(`Insights read with ${r.insightsSource}.`, '');
  else if (r.insightsError) {
    L.push('**Insights unavailable — Graph refused:**');
    for (const [k, v] of Object.entries(r.insightsError)) L.push(`- ${k}: ${v}`);
    L.push('', 'Falling back to public counts (like_count, comments_count).', '');
  }
  L.push('### Instagram', '', '| Date (IST) | Time | Type | Reach | Views | Likes | Saves | Shares | Follows | Comments | Title |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const p of r.ig) {
    const m = p.metrics;
    L.push(`| ${p.date} | ${p.time} | ${p.type} | ${cell(m.reach)} | ${cell(m.views)} | ${cell(m.likes ?? p.like_count)} | ${cell(m.saved)} | ${cell(m.shares)} | ${cell(m.follows)} | ${cell(m.comments ?? p.comments_count)} | ${p.title.replace(/\|/g, '/')} |`);
  }
  L.push('', '### Facebook Page', '');
  if (r.fb.error) L.push(`Facebook read failed: ${r.fb.error}`);
  else {
    L.push('| Date (IST) | Time | Reach | Reactions | Comments | Shares | Clicks | Title |', '|---|---|---|---|---|---|---|---|');
    for (const p of r.fb.posts) {
      L.push(`| ${p.date} | ${p.time} | ${cell(p.metrics.post_impressions_unique)} | ${cell(p.reactions)} | ${cell(p.comments)} | ${cell(p.shares)} | ${cell(p.metrics.post_clicks)} | ${p.title.replace(/\|/g, '/')} |`);
    }
    if (r.fb.fieldErrors?.length) L.push('', 'Facebook fields refused (asked for less):', ...r.fb.fieldErrors.map((e) => `- ${e}`));
    const errs = [...new Set(r.fb.posts.flatMap((p) => Object.entries(p.errors).map(([k, v]) => `${k}: ${v}`)))];
    if (errs.length) L.push('', 'Facebook metric errors:', ...errs.slice(0, 6).map((e) => `- ${e}`));
  }
  const igErrs = [...new Set(r.ig.flatMap((p) => Object.entries(p.errors).map(([k, v]) => `${k}: ${v}`)))];
  if (igErrs.length) L.push('', 'Instagram metric errors:', ...igErrs.slice(0, 8).map((e) => `- ${e}`));
  L.push('', '_Read-only: every request was a GET; nothing was published._');
  return L.join('\n');
}
