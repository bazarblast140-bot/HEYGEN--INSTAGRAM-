#!/usr/bin/env node
// Read-only performance report (Instagram + Facebook Page), last N days.
//
//   node pipeline/insights-report.js [--days 14] [--out pipeline/out/insights.json]
//
// GET requests only. Prints a Markdown report and writes the raw JSON. Exits 0
// even when a metric is refused; the refusal is printed verbatim.

import fs from 'node:fs';
import path from 'node:path';
import { buildReport, toMarkdown, graphError } from './src/insights/report.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const env = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
const days = Number(arg('days', '14')) || 14;
const out = arg('out', 'pipeline/out/insights.json');

try {
  const report = await buildReport({ env, days });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(toMarkdown(report));
} catch (err) {
  console.log(`Could not read the account: ${graphError(err)}`);
}
