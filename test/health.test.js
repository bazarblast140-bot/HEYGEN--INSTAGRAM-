import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  checkCloudflare, checkDeepSeek, checkElevenLabs, checkInstagram, checkPexels,
  expectedCrons, redact, runHealth, syncHealthIssue, workerName,
} from '../pipeline/src/health/check.js';

const NOW = new Date('2026-10-01T08:00:00Z');
const DAY = 24 * 60 * 60;

function okJson(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('instagram expiry under 10 days alerts, and a missing app secret does not invent one', async () => {
  const soon = Math.floor(NOW.getTime() / 1000) + 5 * DAY;
  const later = Math.floor(NOW.getTime() / 1000) + 40 * DAY;
  const fetchSoon = async (url) => (
    String(url).includes('debug_token')
      ? okJson({ data: { is_valid: true, expires_at: soon } })
      : okJson({ id: '1', username: 'rajesh_technical_trader' })
  );
  const expiring = await checkInstagram({
    token: 'page-token', appId: 'app', appSecret: 'secret', fetchImpl: fetchSoon, now: NOW,
  });
  assert.equal(expiring.ok, false);
  assert.match(expiring.detail, /5 days/);
  assert.equal(expiring.detail.includes('page-token'), false);

  const fetchLater = async (url) => (
    String(url).includes('debug_token')
      ? okJson({ data: { is_valid: true, expires_at: later } })
      : okJson({ id: '1', username: 'rajesh_technical_trader' })
  );
  const fine = await checkInstagram({
    token: 'page-token', appId: 'app', appSecret: 'secret', fetchImpl: fetchLater, now: NOW,
  });
  assert.equal(fine.ok, true);

  const unknown = await checkInstagram({
    token: 'page-token', fetchImpl: async () => okJson({ id: '1', username: 'rajesh' }), now: NOW,
  });
  assert.equal(unknown.ok, true);
  assert.match(unknown.detail, /expiry unknown/);
  assert.equal(redact('failed access_token=page-token please', ['page-token']).includes('page-token'), false);
});

test('low balances and a rejected pexels key fail, and a missing cloudflare secret is a skip', async () => {
  const deepseek = await checkDeepSeek({
    token: 'ds',
    minimum: 1,
    fetchImpl: async () => okJson({ is_available: true, balance_infos: [{ total_balance: '0.20' }] }),
  });
  assert.equal(deepseek.ok, false);
  assert.match(deepseek.detail, /0\.2/);

  const voice = await checkElevenLabs({
    token: 'el',
    minimum: 1000,
    fetchImpl: async () => okJson({ character_count: 9000, character_limit: 10000 }),
  });
  assert.equal(voice.ok, true);
  assert.match(voice.detail, /1000 characters/);

  const short = await checkElevenLabs({
    token: 'el',
    fetchImpl: async () => okJson({ character_count: 9900, character_limit: 10000 }),
  });
  assert.equal(short.ok, false);

  const pexels = await checkPexels({ token: 'px', fetchImpl: async () => okJson({}, 401) });
  assert.equal(pexels.ok, false);
  const accepted = await checkPexels({ token: 'px', fetchImpl: async () => okJson({ photos: [] }) });
  assert.equal(accepted.ok, true);

  const skipped = await checkCloudflare({ expected: ['0 7 * * *'] });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.match(skipped.detail, /not checked — secret missing/);
});

test('deployed crons that are not the wrangler schedule are drift', async () => {
  const toml = await fs.readFile(new URL('../scheduler/wrangler.toml', import.meta.url), 'utf8');
  const expected = expectedCrons(toml);
  assert.deepEqual(expected, ['0 7 * * *', '0 14 * * *', '0 4 * * *', '0 11 * * *']);
  assert.equal(workerName(toml), 'factvizer-scheduler');

  const drifted = await checkCloudflare({
    token: 'cf',
    accountId: 'acct',
    scriptName: 'factvizer-scheduler',
    expected,
    fetchImpl: async () => okJson({
      success: true,
      result: { schedules: [{ cron: '37 0 * * *' }, { cron: '37 7 * * *' }, { cron: '37 11 * * *' }] },
    }),
  });
  assert.equal(drifted.ok, false);
  assert.match(drifted.detail, /cron drift/);
  assert.equal(drifted.detail.includes('cf'), false);

  const matched = await checkCloudflare({
    token: 'cf',
    accountId: 'acct',
    scriptName: 'factvizer-scheduler',
    expected,
    fetchImpl: async () => okJson({ success: true, result: { schedules: expected.map((cron) => ({ cron })) } }),
  });
  assert.equal(matched.ok, true);
});

test('one health-alert issue is opened, updated, and closed when the checks recover', async () => {
  const calls = [];
  let open = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).endsWith('/labels')) return okJson({});
    if (String(url).includes('/issues?')) return okJson(open);
    if (options.method === 'POST' && String(url).endsWith('/issues')) {
      open = [{ number: 4, title: 'Health alert' }];
      return okJson({ number: 4 }, 201);
    }
    if (options.method === 'PATCH' && String(url).includes('/issues/4')) {
      const body = JSON.parse(options.body);
      if (body.state === 'closed') open = [];
      return okJson({ number: 4 });
    }
    if (String(url).endsWith('/comments')) return okJson({ id: 1 }, 201);
    return okJson({});
  };

  const bad = { checkedAt: NOW.toISOString(), checks: [{ id: 'pexels', ok: false, detail: 'HTTP 401' }] };
  const opened = await syncHealthIssue({ report: bad, repo: 'owner/repo', token: 'gh', fetchImpl });
  assert.equal(opened.action, 'opened');
  assert.equal(opened.number, 4);
  const updated = await syncHealthIssue({ report: bad, repo: 'owner/repo', token: 'gh', fetchImpl });
  assert.equal(updated.action, 'updated');
  assert.equal(updated.number, 4);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/issues')).length, 1);

  const good = { checkedAt: NOW.toISOString(), checks: [{ id: 'pexels', ok: true, detail: 'key accepted' }] };
  const closed = await syncHealthIssue({ report: good, repo: 'owner/repo', token: 'gh', fetchImpl });
  assert.equal(closed.action, 'closed');
  const none = await syncHealthIssue({ report: good, repo: 'owner/repo', token: 'gh', fetchImpl });
  assert.equal(none.action, 'none');
});

test('a full run treats a missing cloudflare secret as non-failing when the other checks pass', async () => {
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes('/me')) return okJson({ id: '1', username: 'rajesh' });
    if (text.includes('deepseek')) return okJson({ is_available: true, balance_infos: [{ total_balance: '5' }] });
    if (text.includes('elevenlabs')) return okJson({ character_count: 10, character_limit: 5000 });
    if (text.includes('pexels')) return okJson({ photos: [{}] });
    return okJson({});
  };
  const report = await runHealth({
    now: NOW,
    instagram: { token: 'page', fetchImpl },
    deepseek: { token: 'ds', fetchImpl },
    elevenlabs: { token: 'el', fetchImpl },
    pexels: { token: 'px', fetchImpl },
    cloudflare: {},
  });
  assert.equal(report.ok, true);
  assert.match(report.checks.find((check) => check.id === 'cloudflare').detail, /secret missing/);
});
