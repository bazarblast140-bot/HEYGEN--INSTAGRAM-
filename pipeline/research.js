#!/usr/bin/env node
// Daily competitor and hashtag research. Writes data/trends.json.
// On Sunday IST, also writes reports/weekly-YYYY-MM-DD.md.
// Never publishes. A missing token or a refused handle is logged and skipped.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectResearch } from './src/research/collect.js';
import { groundedSummary, isSundayIst, istDate, mergeTrends, weeklyReport } from './src/research/patterns.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const COMPETITORS = path.join(ROOT, 'data', 'competitors.json');
const TRENDS = path.join(ROOT, 'data', 'trends.json');
const REPORTS = path.join(ROOT, 'reports');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function summarise(report, apiKey) {
  if (!apiKey) return '';
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.SCRIPT_MODEL || 'deepseek-chat',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'Summarise only the weekly report you are given. Do not invent posts, hooks, or numbers. If a figure is not in the report, leave it out.',
        },
        { role: 'user', content: report },
      ],
    }),
  });
  if (!res.ok) return '';
  const payload = await res.json().catch(() => ({}));
  const text = payload?.choices?.[0]?.message?.content || '';
  return groundedSummary(text, report);
}

export async function runResearch({
  now = new Date(),
  competitorsPath = COMPETITORS,
  trendsPath = TRENDS,
  reportsDir = REPORTS,
  token = process.env.IG_ACCESS_TOKEN,
  igUserId = process.env.IG_USER_ID,
  apiKey = process.env.DEEPSEEK_API_KEY,
  fetchImpl,
  onNote = (line) => console.log(line),
} = {}) {
  const competitors = await readJson(competitorsPath, { accounts: [], hashtags: [] });
  const previous = await readJson(trendsPath, { patterns: [] });
  const collected = await collectResearch({
    competitors, token, igUserId, previous, now, fetchImpl, onNote,
  });
  const trends = mergeTrends(previous, collected, now);
  await fs.mkdir(path.dirname(trendsPath), { recursive: true });
  await fs.writeFile(trendsPath, `${JSON.stringify(trends, null, 2)}\n`);

  let reportPath = null;
  if (isSundayIst(now)) {
    const date = istDate(now).toISOString().slice(0, 10);
    const draft = weeklyReport(trends, { date });
    let summary = '';
    try {
      summary = await summarise(draft, apiKey);
    } catch (error) {
      onNote?.(`summary skipped: ${String(error.message).slice(0, 80)}`);
    }
    const markdown = summary ? weeklyReport(trends, { date, summary }) : draft;
    await fs.mkdir(reportsDir, { recursive: true });
    reportPath = path.join(reportsDir, `weekly-${date}.md`);
    await fs.writeFile(reportPath, markdown);
    onNote?.(`weekly report ${path.basename(reportPath)}`);
  }
  onNote?.(`${trends.patterns.length} patterns stored`);
  return { trends, reportPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runResearch().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
