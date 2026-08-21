#!/usr/bin/env node
// Token maintenance, run locally so no secret ever leaves your machine.
//
//   node pipeline/token-tool.js inspect
//   node pipeline/token-tool.js longlived      # needs FB_APP_ID + FB_APP_SECRET
//   node pipeline/token-tool.js page           # needs FB_PAGE_ID
//
// Reads IG_ACCESS_TOKEN from the environment. Prints the new token so you can copy
// it straight into GitHub Secrets — nothing is written to disk or sent anywhere.

import 'dotenv/config';
import { exchangeForLongLived, pageToken, inspect } from './src/publish/token.js';

const [command] = process.argv.slice(2);
const token = process.env.IG_ACCESS_TOKEN;
if (!token) { console.error('Set IG_ACCESS_TOKEN in .env first.'); process.exit(1); }

const need = (name) => {
  const v = process.env[name];
  if (!v) { console.error(`This command needs ${name} in .env`); process.exit(1); }
  return v;
};

try {
  if (command === 'inspect') {
    const info = await inspect({ token });
    console.log(`valid:   ${info.valid}`);
    console.log(`expires: ${info.expiresAt}`);
    console.log(`type:    ${info.type}`);
    console.log(`scopes:  ${info.scopes.join(', ')}`);

  } else if (command === 'longlived') {
    const out = await exchangeForLongLived({
      token, appId: need('FB_APP_ID'), appSecret: need('FB_APP_SECRET'),
    });
    console.log(`Long-lived token (${Math.round((out.expiresIn || 0) / 86400)} days):\n\n${out.token}\n`);
    console.log('Put this in .env as IG_ACCESS_TOKEN, and in GitHub Secrets.');

  } else if (command === 'page') {
    const out = await pageToken({ token, pageId: need('FB_PAGE_ID') });
    console.log(`Page token for "${out.name}" (no expiry when derived from a long-lived token):\n\n${out.token}\n`);
    console.log('Run "longlived" first if you have not — a page token from a short-lived one expires too.');

  } else {
    console.error('Usage: node pipeline/token-tool.js <inspect|longlived|page>');
    process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
