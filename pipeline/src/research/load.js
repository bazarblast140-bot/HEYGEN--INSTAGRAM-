import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { trendPrompt } from './patterns.js';

const TRENDS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'trends.json');

/** Empty when the file is missing or nothing in it is younger than 7 days. */
export async function readTrendPrompt(now = new Date(), file = TRENDS) {
  try {
    const trends = JSON.parse(await fs.readFile(file, 'utf8'));
    return trendPrompt(trends, now);
  } catch {
    return '';
  }
}
