#!/usr/bin/env node
// Three-times-daily health check. Opens or updates one health-alert issue
// when something is failing, and closes it when every check is green.
// Does not print secrets and does not publish.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expectedCrons, reportBody, runHealth, syncHealthIssue, workerName } from './src/health/check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function main({ env = process.env, fetchImpl, onNote = console.log } = {}) {
  const toml = await fs.readFile(path.join(ROOT, 'scheduler', 'wrangler.toml'), 'utf8').catch(() => '');
  const number = (name, fallback) => {
    const parsed = Number(env[name]);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const report = await runHealth({
    now: new Date(),
    fetchImpl,
    instagram: {
      token: env.IG_ACCESS_TOKEN,
      appId: env.FB_APP_ID,
      appSecret: env.FB_APP_SECRET,
      fetchImpl,
    },
    deepseek: { token: env.DEEPSEEK_API_KEY, minimum: number('DEEPSEEK_MIN_BALANCE', 1), fetchImpl },
    elevenlabs: { token: env.ELEVENLABS_API_KEY, minimum: number('ELEVENLABS_MIN_CHARS', 1000), fetchImpl },
    pexels: { token: env.PEXELS_API_KEY, fetchImpl },
    cloudflare: {
      token: env.CLOUDFLARE_API_TOKEN,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      scriptName: env.CLOUDFLARE_WORKER_NAME || workerName(toml),
      expected: expectedCrons(toml),
      fetchImpl,
    },
  });
  onNote(reportBody(report));
  const issue = await syncHealthIssue({
    report,
    repo: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    fetchImpl,
  });
  onNote(`issue: ${issue.action}${issue.number ? ` #${issue.number}` : ''}${issue.detail ? ` ${issue.detail}` : ''}`);
  return { report, issue };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(({ issue }) => {
    if (issue.action === 'error') process.exitCode = 1;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
