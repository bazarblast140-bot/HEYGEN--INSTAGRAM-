// Score a carousel or reel before it can be published.
// A miss is sent back to the model. After QUALITY_RETRIES, the build may still
// render, but the run report is not publishable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRENDS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'trends.json');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function qualityRetries(env = process.env) {
  const parsed = Number(env.QUALITY_RETRIES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

export function qualityThreshold(env = process.env) {
  const parsed = Number(env.QUALITY_THRESHOLD);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.7;
}

const words = (text) => String(text || '').replace(/\n/g, ' ').trim().split(/\s+/).filter(Boolean);

function blobOf(spec) {
  return JSON.stringify(spec || {});
}

function hookText(kind, spec) {
  if (kind === 'reel') {
    const first = spec?.segments?.[0] || {};
    return first.card?.headline || first.caption || first.say || '';
  }
  return spec?.slides?.[0]?.headline || '';
}

function spokenHook(spec) {
  return spec?.segments?.[0]?.say || '';
}

export function loadTrends(file = TRENDS) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function freshStyles(trends, now) {
  const at = new Date(now).getTime();
  const styles = (trends?.patterns || [])
    .filter((item) => {
      const then = new Date(item.fetchedAt || item.timestamp).getTime();
      return Number.isFinite(then) && at - then <= WEEK_MS && at - then >= 0 && item.coverStyle;
    })
    .sort((a, b) => (b.engagementRate || 0) - (a.engagementRate || 0))
    .slice(0, 5)
    .map((item) => item.coverStyle);
  return styles;
}

function hookStyle(text) {
  if (/\d/.test(text)) return 'number';
  if (/\?|क्या|क्यों|कैसे|\bkya\b|\bkyun\b/i.test(text)) return 'question';
  return 'statement';
}

function ctaLines(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter((line) => (
    /\?/.test(line) || /comment|कमेंट|save|सेव|share|शेयर|follow|फ़ॉलो|फॉलो/i.test(line)
  ));
}

export function reviewContent({
  kind = 'carousel',
  spec = {},
  trends,
  now = new Date(),
  threshold = qualityThreshold(),
} = {}) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });
  const hook = hookText(kind, spec);
  const hookWords = words(hook);
  const spoken = kind === 'reel' ? words(spokenHook(spec)) : hookWords;
  const caption = String(spec.caption || '');
  const tags = Array.isArray(spec.hashtags) ? spec.hashtags : [];
  const text = blobOf(spec);
  const when = new Date(now);

  add(
    'hook',
    spoken.length >= 3 && spoken.length <= (kind === 'reel' ? 12 : 8)
      && (/\d/.test(hook) || /\?|क्या|क्यों|कैसे|\bkya\b|\bkyun\b|\bkaise\b/i.test(`${hook} ${spokenHook(spec)}`)),
    `hook is ${spoken.length} words`,
  );
  add('number', /\d/.test(text), 'a real number is in the spec');
  add(
    'source',
    /(19|20)\d{2}/.test(text) && (kind === 'reel' || (spec.slides || []).some((slide) => slide.source)),
    'source and a year or date',
  );
  add('cover', hookWords.length >= 2 && hookWords.length <= 8, `cover is ${hookWords.length} words`);
  const lines = ctaLines(caption);
  add('cta', lines.length === 1 && /\?/.test(lines[0]), 'one comment question');
  add('caption', caption.length >= 40 && caption.length <= 700, `caption is ${caption.length} characters`);
  add('hashtags', tags.length >= 1 && tags.length <= 5, `${tags.length} hashtags`);

  const iso = text.match(/20\d{2}-\d{2}-\d{2}/g) || [];
  const years = (text.match(/20\d{2}/g) || []).map(Number);
  const freshIso = iso.some((day) => {
    const at = new Date(`${day}T00:00:00Z`).getTime();
    return when.getTime() - at <= 14 * 24 * 60 * 60 * 1000 && when.getTime() - at >= -24 * 60 * 60 * 1000;
  });
  const freshYear = years.some((year) => year >= when.getUTCFullYear() - 2);
  add('fresh', freshIso || (iso.length === 0 && freshYear), 'source is recent enough');

  const styles = freshStyles(trends === undefined ? loadTrends() : trends, when);
  if (styles.length) {
    add('trend', styles.includes(hookStyle(hook)), `hook style ${hookStyle(hook)}`);
  }

  const passed = checks.filter((check) => check.pass).length;
  const score = checks.length ? passed / checks.length : 0;
  const problems = checks.filter((check) => !check.pass).map((check) => `${check.id}: ${check.detail}`);
  return {
    score: Number(score.toFixed(2)),
    passed,
    total: checks.length,
    threshold,
    pass: score >= threshold,
    problems,
    checks,
  };
}

export function nextQualityStep({
  review,
  fails,
  attempt,
  maxAttempts = 5,
  retries = qualityRetries(),
}) {
  if (review.pass) return { action: 'accept', fails };
  const used = fails + 1;
  if (used < retries && attempt < maxAttempts) return { action: 'retry', fails: used };
  return { action: 'skip', fails: used };
}
