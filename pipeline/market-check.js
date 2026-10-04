#!/usr/bin/env node
// Evening slot, before any model call: is there a verified close dated today?
// Sets ok=true|false; false skips the build (and so the post, Story and FB copy).
import fs from 'node:fs/promises';
import { marketCloseStories } from './src/carousel/market.js';
import { clock } from './src/publish/same-day.js';

const res = await marketCloseStories({ now: clock().getTime(), onNote: (n) => console.log(n) });
console.log(res.ok ? `market close verified for ${res.date}` : `## Skipped — ${res.reason}. No model call, nothing posted (no IG post, no Story, no FB copy).`);
if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `ok=${res.ok}\n`);
