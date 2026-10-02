// Read-only checks for the accounts this pipeline spends money on.
// Nothing here prints a token. A missing optional secret is a skip, not a failure.

const DAY_MS = 24 * 60 * 60 * 1000;

export function redact(text, secrets = []) {
  let out = String(text || '');
  for (const secret of secrets) {
    if (secret && String(secret).length > 4) out = out.split(String(secret)).join('***');
  }
  return out
    .replace(/access_token=[^&\s]+/gi, 'access_token=***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/xi-api-key:\s*\S+/gi, 'xi-api-key: ***');
}

export function expectedCrons(toml) {
  const match = String(toml || '').match(/crons\s*=\s*\[([^\]]*)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

export function workerName(toml) {
  const match = String(toml || '').match(/^\s*name\s*=\s*"([^"]+)"/m);
  return match?.[1] || 'factvizer-scheduler';
}

async function readJson(res) {
  return res.json().catch(() => ({}));
}

function fail(id, detail) {
  return { id, ok: false, detail: String(detail || '').slice(0, 240) };
}

export async function checkInstagram({
  token, appId, appSecret, fetchImpl = fetch, now = new Date(),
  host = 'https://graph.facebook.com', version = 'v23.0',
} = {}) {
  if (!token) return fail('instagram', 'IG_ACCESS_TOKEN missing');
  const secrets = [token, appSecret];
  try {
    const meRes = await fetchImpl(`${host}/${version}/me?fields=id,username&access_token=${encodeURIComponent(token)}`);
    const me = await readJson(meRes);
    if (!meRes.ok || me.error) return fail('instagram', redact(me.error?.message || `HTTP ${meRes.status}`, secrets));
    if (!appId || !appSecret) {
      return { id: 'instagram', ok: true, detail: `token valid for ${me.username || me.id}; expiry unknown` };
    }
    const appToken = `${appId}|${appSecret}`;
    const debugRes = await fetchImpl(
      `${host}/${version}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`,
    );
    const debug = await readJson(debugRes);
    const data = debug.data || {};
    if (!debugRes.ok || debug.error || data.is_valid === false) {
      return fail('instagram', redact(debug.error?.message || 'token is not valid', secrets));
    }
    const expiresAt = Number(data.expires_at) || 0;
    if (!expiresAt) return { id: 'instagram', ok: true, detail: `token valid for ${me.username || me.id}; expiry none` };
    const days = (expiresAt * 1000 - now.getTime()) / DAY_MS;
    if (days < 10) return fail('instagram', `token expires in ${Math.max(0, Math.floor(days))} days`);
    return { id: 'instagram', ok: true, detail: `token valid for ${me.username || me.id}; ${Math.floor(days)} days left` };
  } catch (error) {
    return fail('instagram', redact(error.message, secrets));
  }
}

export async function checkDeepSeek({ token, minimum = 1, fetchImpl = fetch } = {}) {
  if (!token) return fail('deepseek', 'DEEPSEEK_API_KEY missing');
  try {
    const res = await fetchImpl('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await readJson(res);
    if (!res.ok) return fail('deepseek', redact(body.error?.message || `HTTP ${res.status}`, [token]));
    if (body.is_available === false) return fail('deepseek', 'balance is not available');
    const totals = (body.balance_infos || []).map((row) => Number(row.total_balance)).filter((n) => Number.isFinite(n));
    const balance = totals.length ? Math.min(...totals) : 0;
    if (balance < minimum) return fail('deepseek', `balance ${balance} is below ${minimum}`);
    return { id: 'deepseek', ok: true, detail: `balance ${balance}` };
  } catch (error) {
    return fail('deepseek', redact(error.message, [token]));
  }
}

export async function checkElevenLabs({ token, minimum = 1000, fetchImpl = fetch } = {}) {
  if (!token) return fail('elevenlabs', 'ELEVENLABS_API_KEY missing');
  try {
    const res = await fetchImpl('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': token },
    });
    const body = await readJson(res);
    if (!res.ok) return fail('elevenlabs', redact(body.detail?.message || body.detail || `HTTP ${res.status}`, [token]));
    const remaining = Number(body.character_limit) - Number(body.character_count);
    if (!Number.isFinite(remaining)) return fail('elevenlabs', 'subscription did not include a character balance');
    if (remaining < minimum) return fail('elevenlabs', `${remaining} characters left, below ${minimum}`);
    return { id: 'elevenlabs', ok: true, detail: `${remaining} characters left` };
  } catch (error) {
    return fail('elevenlabs', redact(error.message, [token]));
  }
}

export async function checkPexels({ token, fetchImpl = fetch } = {}) {
  if (!token) return fail('pexels', 'PEXELS_API_KEY missing');
  try {
    const res = await fetchImpl('https://api.pexels.com/v1/search?query=market&per_page=1', {
      headers: { Authorization: token },
    });
    if (res.ok) return { id: 'pexels', ok: true, detail: 'key accepted' };
    return fail('pexels', `HTTP ${res.status}`);
  } catch (error) {
    return fail('pexels', redact(error.message, [token]));
  }
}

export function deployedCrons(payload) {
  const result = payload?.result ?? payload;
  const list = Array.isArray(result) ? result : (result?.schedules || []);
  return list.map((item) => (typeof item === 'string' ? item : item?.cron)).filter(Boolean);
}

export async function checkCloudflare({
  token, accountId, scriptName, expected = [], fetchImpl = fetch,
} = {}) {
  if (!token || !accountId) {
    return { id: 'cloudflare', ok: true, skipped: true, detail: 'not checked — secret missing' };
  }
  try {
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/schedules`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await readJson(res);
    if (!res.ok || body.success === false) {
      return fail('cloudflare', redact(body.errors?.[0]?.message || `HTTP ${res.status}`, [token]));
    }
    const found = deployedCrons(body);
    const missing = expected.filter((cron) => !found.includes(cron));
    const extra = found.filter((cron) => !expected.includes(cron));
    if (missing.length || extra.length) {
      return fail('cloudflare', `cron drift. missing ${missing.join(', ') || 'none'}. extra ${extra.join(', ') || 'none'}`);
    }
    return { id: 'cloudflare', ok: true, detail: `${found.length} crons match` };
  } catch (error) {
    return fail('cloudflare', redact(error.message, [token]));
  }
}

export function reportBody(report) {
  const lines = [`Checked ${report.checkedAt}`, ''];
  for (const check of report.checks) {
    const state = check.ok ? (check.skipped ? 'SKIP' : 'OK') : 'FAIL';
    lines.push(`- ${state} ${check.id}: ${check.detail}`);
  }
  return lines.join('\n');
}

export async function syncHealthIssue({
  report, repo, token, fetchImpl = fetch,
} = {}) {
  if (!repo || !token) return { action: 'skipped', detail: 'GITHUB_TOKEN or repository missing' };
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'rajesh-health-check',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const base = `https://api.github.com/repos/${repo}`;
  await fetchImpl(`${base}/labels`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'health-alert', color: 'b60205', description: 'Pipeline health check' }),
  });
  const listRes = await fetchImpl(`${base}/issues?state=open&labels=health-alert&per_page=20`, { headers });
  const open = await readJson(listRes);
  const existing = Array.isArray(open) ? open.find((issue) => !issue.pull_request) : null;
  const failing = report.checks.filter((check) => check.ok === false);
  const body = reportBody(report);

  if (!failing.length) {
    if (!existing) return { action: 'none' };
    const closed = await fetchImpl(`${base}/issues/${existing.number}`, {
      method: 'PATCH', headers, body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    });
    if (!closed.ok) return { action: 'error', detail: `could not close #${existing.number}` };
    return { action: 'closed', number: existing.number };
  }

  if (!existing) {
    const createdRes = await fetchImpl(`${base}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Health alert', body, labels: ['health-alert'] }),
    });
    const created = await readJson(createdRes);
    if (!createdRes.ok) return { action: 'error', detail: redact(created.message || 'could not open issue', [token]) };
    return { action: 'opened', number: created.number };
  }

  const patched = await fetchImpl(`${base}/issues/${existing.number}`, {
    method: 'PATCH', headers, body: JSON.stringify({ title: 'Health alert', body }),
  });
  if (!patched.ok) return { action: 'error', detail: `could not update #${existing.number}` };
  await fetchImpl(`${base}/issues/${existing.number}/comments`, {
    method: 'POST', headers, body: JSON.stringify({ body }),
  });
  return { action: 'updated', number: existing.number };
}

export async function runHealth(options = {}) {
  const checks = [];
  checks.push(await checkInstagram(options.instagram || {}));
  checks.push(await checkDeepSeek(options.deepseek || {}));
  checks.push(await checkElevenLabs(options.elevenlabs || {}));
  checks.push(await checkPexels(options.pexels || {}));
  checks.push(await checkCloudflare(options.cloudflare || {}));
  const failing = checks.filter((check) => check.ok === false);
  return {
    checkedAt: (options.now || new Date()).toISOString(),
    ok: failing.length === 0,
    checks,
  };
}
